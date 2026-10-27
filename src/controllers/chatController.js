// src/controllers/chatController.js

import mongoose from "mongoose";
import { Project } from "../models/Project.js";
import { reviseProject, rewriteFile } from "../services/ai.js";
import {
  applyOperations,
  hashContent,
  newFileDrafts,
} from "../services/diff.js";
import { repairRevisionEntries } from "../services/contract/revisionCheck.js";
import { decodeWhitespaceEntities } from "../services/contentNormalizer.js";
import { extractUrls } from "../services/webReference.js";
import { serializeProject } from "./projectController.js";
import { resolveScope } from "../services/revisionScope.js";
import {
  buildAllowlist,
  findInventedFacts,
} from "../services/contract/factGuard.js";
import {
  chargeCredits,
  creditCosts,
  getBalance,
  refundCredits,
  refundHeld,
  rejectCharge,
} from "../services/credits.js";
import {
  markUsageFailed,
  withUsageTracking,
} from "../services/usageTracker.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { fail } from "../utils/apiError.js";
import { ensureUnsplashCredits } from "../services/stockImages.js";

const MAX_PROMPT_LENGTH = 4000;

export const buildManifest = (files) => {
  const manifest = [];
  for (const [path, entry] of Object.entries(files || {})) {
    manifest.push({
      path,
      hash: entry?.hash,
      size: entry?.content?.length ?? 0,
    });
  }
  return manifest;
};

// A2: history filter. The current prompt is already the last message, so it
// is dropped from `recentMessages`, and so is the "Created file …" chatter
// that floods the project's messages array during generation.
const NOISE_RE =
  /^(Created file |Planning project|Planned website structure|Website generation complete)/;

const chatHandler = async (req, res) => {
  const prompt =
    typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";

  if (!prompt) {
    return fail(res, 400, "CHAT_PROMPT_REQUIRED", {}, "prompt is required");
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    return fail(
      res,
      400,
      "CHAT_PROMPT_TOO_LONG",
      { max: MAX_PROMPT_LENGTH },
      `prompt is too long (max ${MAX_PROMPT_LENGTH} characters)`,
    );
  }

  const { id } = req.params;
  const owner = req.user.userId;

  if (!mongoose.isObjectIdOrHexString(id)) {
    return fail(res, 404, "PROJECT_NOT_FOUND", {}, "Project not found");
  }

  const cost = creditCosts().revision;
  const charge = await chargeCredits(owner, cost);
  if (!charge.ok) {
    rejectCharge(res, charge);
    return;
  }

  const project = await Project.acquireLock(id, owner, "revising", {
    creditsHeld: cost,
  });

  if (!project) {
    await refundCredits(owner, cost);
    const exists = await Project.exists({ _id: id, owner });
    if (!exists) {
      return fail(res, 404, "PROJECT_NOT_FOUND", {}, "Project not found");
    }
    return fail(
      res,
      409,
      "PROJECT_BUSY",
      {},
      "The project is still being generated or revised. Try again when it finishes.",
    );
  }

  try {
    project.messages.push({
      role: "user",
      content: prompt,
      timestamp: new Date(),
    });
    await project.save();

    let healed = false;
    for (const [path, entry] of Object.entries(project.files || {})) {
      if (typeof entry?.content !== "string") continue;
      const fixed = decodeWhitespaceEntities(entry.content);
      if (fixed !== entry.content) {
        project.files[path] = { content: fixed, hash: hashContent(fixed) };
        healed = true;
        console.log(`[Heal] ${path}: decoded newline entities in stored file`);
      }
    }
    if (healed) project.markModified("files");

    const AI_HIDDEN = new Set(["/public/index.html"]);
    const manifest = buildManifest(project.files).filter(
      (f) => !AI_HIDDEN.has(f.path),
    );

    // C2: revision scope. If the prompt names specific files/sections, only
    // those go in `relevantFiles`; the rest stay in the manifest only.
    // HARNESS_REVISION_SCOPE=0 disables the narrowing (mode "all").
    const allPaths = Object.keys(project.files || {}).filter(
      (p) => !AI_HIDDEN.has(p),
    );
    const scope =
      process.env.HARNESS_REVISION_SCOPE !== "0"
        ? resolveScope(prompt, allPaths)
        : { mode: "all", files: new Set(allPaths), reason: "disabled" };
    const scopeFiles = scope.mode === "files" ? scope.files : null;
    if (scope.mode === "files") {
      console.log(
        `[RevisionScope] mode=files files=${[...scopeFiles].join(", ")} reason=${scope.reason}`,
      );
    } else {
      console.log(`[RevisionScope] mode=all reason=${scope.reason}`);
    }

    const relevantFiles = {};
    for (const [path, entry] of Object.entries(project.files || {})) {
      if (AI_HIDDEN.has(path)) continue;
      if (scopeFiles && !scopeFiles.has(path)) continue;
      relevantFiles[path] = entry?.content ?? "";
    }

    // A2: clean history — current prompt excluded, chatter excluded, capped
    // at the last 4 messages, each message at most 500 chars.
    const recentMessages = (project.messages ?? [])
      .slice(0, -1)
      .filter((m) => !NOISE_RE.test(m.content))
      .slice(-4)
      .map((m) => ({
        role: m.role,
        content: String(m.content).slice(0, 500),
      }));

    const historyUrls = extractUrls(
      project.messages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .reverse()
        .join("\n"),
    );

    // A5.5: project.brief may be a Mongoose subdocument. Convert it to a plain
    // object so buildBriefBlock sees a stable shape.
    const briefSnapshot = project.brief?.toObject?.() ?? project.brief ?? null;

    const result = await reviseProject(
      prompt,
      manifest,
      relevantFiles,
      recentMessages,
      historyUrls,
      project.uploadedImages || [],
      {
        brief: briefSnapshot,
        concept: project.description,
        scope,
      },
    );

    console.log(
      `[AI] Got ${result.operations.length} operations: ${result.description}`,
    );

    const applyResult = applyOperations(project.files, result.operations);
    const { files: updatedFiles, applied } = applyResult;
    let { errors } = applyResult;

    const MAX_REWRITES = parseInt(process.env.AI_MAX_REWRITES || "8", 10);
    const REWRITE_BATCH = parseInt(process.env.AI_REWRITE_BATCH || "3", 10);
    const drafts = newFileDrafts(project.files, result.operations);
    const sourceOf = (p) => project.files?.[p]?.content || drafts[p];
    const toRewrite = (applyResult.failedPaths || [])
      .filter((p) => sourceOf(p) && /\.(jsx?|css)$/i.test(p))
      .slice(0, MAX_REWRITES);

    if (toRewrite.length > 0) {
      console.log(
        `[AI] Patches failed for ${toRewrite.join(", ")}, rewriting whole file(s)`,
      );
      const rewritten = [];
      const rewriteOne = async (p) => {
        try {
          const code = await rewriteFile({
            path: p,
            current: sourceOf(p),
            draft: !project.files?.[p],
            prompt,
            description: result.description,
            allPaths: [...new Set([...Object.keys(updatedFiles), p])],
            assets: result.assets,
            referenceContext: result.referenceContext,
            briefBlock: result.briefBlock,
          });
          updatedFiles[p] = { content: code, hash: hashContent(code) };
          applied.push(`rewrote ${p}`);
          rewritten.push(p);
        } catch (err) {
          console.warn(`[AI] Rewrite fallback failed for ${p}: ${err.message}`);
        }
      };
      for (let i = 0; i < toRewrite.length; i += REWRITE_BATCH) {
        await Promise.all(
          toRewrite.slice(i, i + REWRITE_BATCH).map(rewriteOne),
        );
      }
      errors = errors.filter(
        (e) => !rewritten.some((p) => e.includes(` ${p}:`)),
      );
    }

    if (errors.length) {
      console.warn(`[Diff] Errors applying operations: `, errors);
    }

    const zeroOperations = (result.operations || []).length === 0;
    const nothingApplied = applied.length === 0;
    if (zeroOperations || nothingApplied) {
      markUsageFailed(
        new Error(zeroOperations ? "zero operations" : "no operations applied"),
      );
    }

    // Unsplash credits: dipasang server, bukan LLM.
    if (!nothingApplied && result.stockAssets?.length) {
      const plain = Object.fromEntries(
        Object.entries(updatedFiles).map(([p, f]) => [p, f?.content ?? ""]),
      );
      const credits = ensureUnsplashCredits(plain, result.stockAssets);
      for (const p of credits.changed) {
        updatedFiles[p] = {
          content: credits.files[p],
          hash: hashContent(credits.files[p]),
        };
        applied.push(`credits ${p}`);
      }
      if (credits.changed.length) {
        console.log(
          `[Unsplash] credits updated: ${credits.changed.join(", ")}`,
        );
      }
    }

    let finalFiles = updatedFiles;
    let autoFixes = [];
    if (!nothingApplied) {
      try {
        const repaired = await repairRevisionEntries(
          project.files,
          updatedFiles,
        );
        finalFiles = repaired.entries;
        autoFixes = repaired.autoFixes;
        if (autoFixes.length > 0) {
          console.log(
            `[Contract] revision: ${autoFixes.length} fix(es):\n  - ${autoFixes.join("\n  - ")}`,
          );
        }
        if (repaired.notes.length > 0) {
          console.warn(
            `[Contract] revision notes:\n  - ${repaired.notes.join("\n  - ")}`,
          );
        }
      } catch (err) {
        console.error(
          "[Contract] revision check failed, keeping the revision as the model wrote it:",
          err,
        );
      }
    }

    if (!nothingApplied) {
      project.files = finalFiles;
      project.markModified("files");
      project.version += 1;
      project.creditsHeld = 0;
    }

    // C1 log-only for revisions: after applyOperations, scan the touched files
    // against the brief + concept + revision prompt allowlist. Never blocks.
    // HARNESS_FACT_GUARD=0 disables it.
    if (
      process.env.HARNESS_FACT_GUARD !== "0" &&
      briefSnapshot &&
      !nothingApplied
    ) {
      try {
        const sources = [
          String(project.description ?? ""),
          String(prompt ?? ""),
          String(result.referenceContext ?? ""),
        ];
        const answers = briefSnapshot?.answers ?? {};
        const slots = Array.isArray(briefSnapshot?.slots)
          ? briefSnapshot.slots
          : [];
        for (const slot of slots) {
          const v = answers[slot.key]?.value;
          if (typeof v === "string" && v.trim()) sources.push(v);
          if (typeof slot.placeholder === "string" && slot.placeholder.trim()) {
            sources.push(slot.placeholder);
          }
        }
        const allow = buildAllowlist(sources);
        const touchedPaths = new Set();
        for (const op of result.operations || []) {
          if (op.path) touchedPaths.add(op.path);
        }
        for (const a of applied) {
          const m = a.match(/(?:created|updated|deleted|rewrote) (\S+)/);
          if (m) touchedPaths.add(m[1]);
        }
        let warned = 0;
        for (const p of touchedPaths) {
          const code = project.files?.[p]?.content;
          if (typeof code !== "string") continue;
          const facts = findInventedFacts(code, allow);
          if (facts.length > 0) {
            warned++;
            console.warn(
              `[FactGuard] revision ${p}: ${facts.length} potential invented fact(s): ${JSON.stringify(
                facts.map((f) => ({
                  kind: f.kind,
                  value: f.value,
                  line: f.line,
                })),
              )}`,
            );
          }
        }
        if (warned === 0) {
          console.log(
            `[FactGuard] revision: no potential invented facts in touched files`,
          );
        }
      } catch (err) {
        console.warn(`[FactGuard] revision check failed: ${err.message}`);
      }
    }

    project.status = "completed";
    project.error = null;
    project.errorCode =
      zeroOperations || nothingApplied ? "REVISION_NO_CHANGE" : null;

    // B3: distinguish "the model returned zero operations" from "operations
    // existed but none could be applied".
    let assistantMessage;
    if (zeroOperations) {
      assistantMessage = `AI tidak menghasilkan perubahan: ${
        result.description || "tidak ada perubahan yang bisa diterapkan"
      }`;
    } else if (nothingApplied) {
      assistantMessage =
        "Perubahan belum berhasil diterapkan (AI salah menunjuk bagian kode). Coba kirim ulang permintaannya, atau sebutkan bagian yang mau diubah lebih spesifik.";
    } else {
      assistantMessage =
        result.description +
        (errors.length > 0
          ? `\n\n Some operations failed: ${errors.join(", ")}`
          : "");
    }

    project.messages.push({
      role: "assistant",
      content: assistantMessage,
    });

    await project.save();

    const refunded =
      zeroOperations || nothingApplied ? await refundHeld(project._id) : 0;

    res.json({
      ...serializeProject(project),
      applied,
      errors,
      autoFixes,
      aiDescription: result.description,
      credits: await getBalance(owner),
      refunded,
    });
  } catch (err) {
    markUsageFailed(err);
    console.error(`[AI Revision Error] ${err.message}`);

    try {
      await Project.updateOne(
        { _id: project._id },
        { $set: { status: "completed" } },
      );
    } catch (releaseErr) {
      console.error(
        `[AI Revision Error] could not release project ${project._id}: ${releaseErr.message}`,
      );
    }

    const refunded = await refundHeld(project._id);

    res.status(500).json({
      error: err.message || "Failed to process revision request",
      code: "CHAT_FAILED",
      params: {},
      credits: await getBalance(owner),
      refunded,
    });
  }
};

export const chat = asyncHandler((req, res) =>
  withUsageTracking("revision", () => chatHandler(req, res), {
    projectId: req.params.id,
  }),
);
