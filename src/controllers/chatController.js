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
    // ... (sisa logika revision sama persis seperti aslinya, gua skip
    //      bagian ini karena panjang dan tidak ada perubahan) ...

    project.messages.push({
      role: "user",
      content: prompt,
      timestamp: new Date(),
    });
    await project.save();

    // ... semua logic heal, manifest, relevantFiles, recentMessages,
    //     historyUrls, reviseProject, applyOperations, rewrite fallback,
    //     repairRevisionEntries ... (TIDAK ADA PERUBAHAN)

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

    const relevantFiles = {};
    for (const [path, entry] of Object.entries(project.files || {})) {
      if (AI_HIDDEN.has(path)) continue;
      relevantFiles[path] = entry?.content ?? "";
    }

    const recentMessages = project.messages.slice(-4).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const historyUrls = extractUrls(
      project.messages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .reverse()
        .join("\n"),
    );

    const result = await reviseProject(
      prompt,
      manifest,
      relevantFiles,
      recentMessages,
      historyUrls,
      project.uploadedImages || [],
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

    const nothingApplied = applied.length === 0;
    if (nothingApplied) markUsageFailed(new Error("no operations applied"));

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
    project.status = "completed";
    project.error = null;
    // Revision yang nggak ngubah apa-apa tetap dianggap "completed" tapi
    // dengan errorCode khusus, biar client bisa nampilin pesan yang jelas.
    project.errorCode = nothingApplied ? "REVISION_NO_CHANGE" : null;

    project.messages.push({
      role: "assistant",
      content: nothingApplied
        ? "Perubahan belum berhasil diterapkan (AI salah menunjuk bagian kode). Coba kirim ulang permintaannya, atau sebutkan bagian yang mau diubah lebih spesifik."
        : result.description +
          (errors.length > 0
            ? `\n\n Some operations failed: ${errors.join(", ")}`
            : ""),
    });

    await project.save();

    const refunded = nothingApplied ? await refundHeld(project._id) : 0;

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

    // err.message tetap dikirim sebagai `error` (fallback English/debug),
    // tapi client bakal pakai `code` buat translate.
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
