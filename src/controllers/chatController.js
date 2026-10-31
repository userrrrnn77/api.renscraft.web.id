// src/controllers/chatController.js

import mongoose from "mongoose";
import { Project } from "../models/Project.js";
import { reviseProject, rewriteFile } from "../services/ai.js";
import {
  applyOperations,
  hashContent,
  newFileDrafts,
} from "../services/diff.js";
import {
  repairRevisionEntries,
  deriveContract,
} from "../services/contract/revisionCheck.js";
import { decodeWhitespaceEntities } from "../services/contentNormalizer.js";
import { extractUrls } from "../services/webReference.js";
import { serializeProject } from "./projectController.js";
import { resolveScope } from "../services/revisionScope.js";
import {
  findInventedFacts,
  findVagueClaims,
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
import { saveProjectVersion } from "../services/projectVersions.js";
import { buildFactContext } from "../services/contract/factContext.js";
import { runQualityGate } from "../services/qa/qualityGate.js";
import { buildQualityReport } from "../services/quality.js";

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

    // Snapshot "before" untuk derive contract + gate
    const beforeFiles = Object.fromEntries(
      Object.entries(project.files || {}).map(([p, e]) => [
        p,
        e?.content ?? "",
      ]),
    );

    const AI_HIDDEN = new Set(["/public/index.html"]);
    const manifest = buildManifest(project.files).filter(
      (f) => !AI_HIDDEN.has(f.path),
    );

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

    const SERVER_OWNED = new Set(["/lib/renscraft.js"]);
    const droppedSdk = result.operations.filter((op) =>
      SERVER_OWNED.has(op.path),
    );
    if (droppedSdk.length > 0) {
      console.warn(
        `[Revision] dropped ${droppedSdk.length} op(s) on server-owned paths: ${droppedSdk.map((o) => `${o.op} ${o.path}`).join(", ")}`,
      );
      result.operations = result.operations.filter(
        (op) => !SERVER_OWNED.has(op.path),
      );
    }

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

    // ── F6.1: QA gate untuk revisi ──────────────────────────────────────
    // Static + Bundle; Render opsional via REVISION_QA_RENDER.
    // Blocking issue di mode "enforce" append ke `errors` → atomic abort.
    let revisionGateMode = "off";
    let revisionGateIssues = [];
    let revisionGateStages = {};
    if (process.env.HARNESS_QA_GATE !== "0" && !nothingApplied) {
      try {
        const contract = deriveContract(beforeFiles);
        const finalFilesPlain = Object.fromEntries(
          Object.entries(finalFiles).map(([p, e]) => [
            p,
            typeof e === "string" ? e : (e?.content ?? ""),
          ]),
        );
        const gate = await runQualityGate(finalFilesPlain, contract);
        revisionGateMode = gate.mode;
        revisionGateStages = gate.stages || {};
        revisionGateIssues = gate.reportable ? gate.issues : [];

        const fmt = (i) =>
          `${i.code}${i.path ? ` @ ${i.path}` : ""}: ${i.message}`;

        if (gate.mode === "enforce") {
          const blocking = gate.issues.filter((i) => i.severity === "blocking");
          if (blocking.length > 0) {
            console.log(
              `[QA] revision: ${blocking.length} blocking issue(s):\n  - ` +
                blocking.map(fmt).join("\n  - "),
            );
            errors = errors.concat(
              blocking.map((i) => `QA ${i.code}: ${i.message}`.slice(0, 200)),
            );
          } else if (gate.issues.length > 0) {
            console.log(
              `[QA] revision: passed with ${gate.issues.length} warning(s)`,
            );
          } else {
            console.log(`[QA] revision: passed`);
          }
        } else if (gate.mode === "shadow" && gate.loggable?.length > 0) {
          console.log(
            `[QA] revision shadow: ${gate.loggable.length} blocking issue(s) (not applied):\n  - ` +
              gate.loggable.map(fmt).join("\n  - "),
          );
        } else if (gate.mode !== "off" && gate.issues.length === 0) {
          console.log(`[QA] revision ${gate.mode}: passed`);
        }
      } catch (err) {
        console.warn(
          `[QA] revision gate crashed (not blocking): ${err.message}`,
        );
      }
    }

    // ── F6: atomic decision ─────────────────────────────────────────────
    const atomicMode = process.env.HARNESS_REVISION_ATOMIC !== "0";
    const atomicAbort = atomicMode && !nothingApplied && errors.length > 0;
    const shouldCommit = !nothingApplied && !atomicAbort;

    // ── Files yang benar-benar tersentuh revisi ini ─────────────────────
    // Dipakai oleh Fact Guard (C1) dan vague-claims check (F7) di bawah.
    // HARUS di scope luar (bukan di dalam try) supaya dua blok try bisa
    // mengaksesnya tanpa ReferenceError.
    const touchedPaths = new Set();
    for (const op of result.operations || []) {
      if (op.path) touchedPaths.add(op.path);
    }
    for (const a of applied) {
      const m = a.match(/(?:created|updated|deleted|rewrote) (\S+)/);
      if (m) touchedPaths.add(m[1]);
    }

    if (shouldCommit) {
      const newVersion = project.version + 1;
      await saveProjectVersion({
        projectId: project._id,
        version: newVersion,
        files: finalFiles,
        prompt,
        quality: project.quality ?? null,
      }).catch((err) =>
        console.error("[Version] save failed, continuing:", err),
      );

      project.files = finalFiles;
      project.markModified("files");
      project.version = newVersion;
      project.creditsHeld = 0;

      // F5.8: simpan hasil gate revisi ke QualityReport
      if (revisionGateMode !== "off") {
        project.quality = buildQualityReport(
          revisionGateIssues.map((i) => ({
            code: i.code,
            severity: i.severity,
            stage: i.stage || "static",
            path: i.path,
            message: i.message,
            autoFixed: false,
          })),
          { stages: revisionGateStages, version: newVersion },
        );
        project.markModified("quality");
      }
    } else if (atomicAbort) {
      console.log(
        `[Revision:atomic] aborted — ${errors.length} error(s), candidate discarded`,
      );
    }

    // C1: fact guard log-only (existing behaviour)
    if (
      process.env.HARNESS_FACT_GUARD !== "0" &&
      shouldCommit &&
      process.env.HARNESS_FACT_GUARD_REVISION !== "0"
    ) {
      try {
        const userMessages = (project.messages ?? [])
          .filter((m) => m.role === "user")
          .map((m) => ({ role: m.role, content: m.content }));

        const factCtx = buildFactContext({
          prompt: String(project.description ?? ""),
          brief: briefSnapshot,
          revisionPrompt: prompt,
          userMessages,
        });
        const allow = factCtx.allow;

        const blockingKinds = new Set([
          "phone",
          "email",
          "price",
          "stat",
          "rating",
          "year",
        ]);
        const MAX_FACT_REGEN = 2;

        const scored = [];
        for (const p of touchedPaths) {
          const code = finalFiles[p]?.content ?? finalFiles[p];
          if (typeof code !== "string") continue;
          if (!/\.(jsx?)$/i.test(p)) continue;
          const facts = findInventedFacts(code, allow);
          const blocking = facts.filter((f) => blockingKinds.has(f.kind));
          if (blocking.length === 0) continue;
          scored.push({ path: p, blocking });
        }

        if (scored.length === 0) {
          console.log(
            `[FactGuard] revision: no invented facts in touched files`,
          );
        } else {
          scored.sort((a, b) => b.blocking.length - a.blocking.length);
          const toFix = scored.slice(0, MAX_FACT_REGEN);
          console.log(
            `[FactGuard] revision: ${scored.length} file(s) with blocking facts, regen ${toFix.length}`,
          );

          for (const entry of toFix) {
            const p = entry.path;
            const before = finalFiles[p]?.content ?? finalFiles[p];
            if (typeof before !== "string") continue;
            const values = entry.blocking.map((f) => f.value);
            try {
              const newCode = await rewriteFile({
                path: p,
                current: before,
                prompt:
                  `The revision introduced invented facts: ${JSON.stringify(values)}. ` +
                  `Rewrite this file removing those invented values. ` +
                  `Only use facts that appear in the brief, the original prompt, or the user's message. ` +
                  `Where data is missing, use the placeholder from the brief.`,
                description: result.description,
                allPaths: [...new Set([...Object.keys(finalFiles), p])],
                assets: result.assets ?? [],
                referenceContext: result.referenceContext ?? "",
                briefBlock: result.briefBlock ?? "",
                draft: false,
              });
              const afterFacts = findInventedFacts(newCode, allow);
              const afterCount = afterFacts.filter((f) =>
                blockingKinds.has(f.kind),
              ).length;
              if (afterCount < entry.blocking.length) {
                finalFiles[p] = {
                  content: newCode,
                  hash: hashContent(newCode),
                };
                console.log(
                  `[FactGuard] revision ${p}: ${entry.blocking.length} -> ${afterCount} blocking fact(s)`,
                );
              } else {
                console.log(
                  `[FactGuard] revision ${p}: regen did not improve, keeping current`,
                );
              }
            } catch (err) {
              console.warn(
                `[FactGuard] revision ${p}: regen failed (${err.message}), keeping current`,
              );
            }
          }
        }
      } catch (err) {
        console.warn(`[FactGuard] revision check failed: ${err.message}`);
      }
    }

    // F7: vague claims → warning. Nggak blocking.
    if (
      process.env.HARNESS_FACT_GUARD !== "0" &&
      process.env.HARNESS_FACT_GUARD_REVISION !== "0"
    ) {
      try {
        const vagueWarnings = [];
        for (const p of touchedPaths) {
          const code = finalFiles[p]?.content ?? finalFiles[p];
          if (typeof code !== "string") continue;
          if (!/\.(jsx?)$/i.test(p)) continue;
          const claims = findVagueClaims(code);
          for (const c of claims) vagueWarnings.push({ path: p, ...c });
        }
        if (vagueWarnings.length > 0) {
          console.warn(
            `[FactGuard] revision: ${vagueWarnings.length} vague claim(s): ` +
              vagueWarnings
                .slice(0, 5)
                .map((v) => `${v.path}:${v.line} "${v.value}"`)
                .join("; "),
          );
        }
      } catch (err) {
        console.warn(`[FactGuard] vague claim check failed: ${err.message}`);
      }
    }

    project.status = "completed";
    project.error = null;
    project.errorCode = zeroOperations
      ? "REVISION_NO_CHANGE"
      : atomicAbort
        ? "REVISION_ABORTED"
        : nothingApplied
          ? "REVISION_NO_CHANGE"
          : null;

    let assistantMessage;
    if (zeroOperations) {
      assistantMessage = `AI tidak menghasilkan perubahan: ${result.description || "tidak ada perubahan yang bisa diterapkan"}`;
    } else if (atomicAbort) {
      assistantMessage = `Revisi dibatalkan karena ${errors.length} masalah (operasi gagal dan/atau QA gate). Versi project tidak berubah, kredit sudah dikembalikan. Coba lagi dengan permintaan yang lebih spesifik.`;
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

    const refunded = !shouldCommit ? await refundHeld(project._id) : 0;

    if (atomicAbort) {
      return res.status(409).json({
        error: assistantMessage,
        code: "REVISION_ABORTED",
        params: { failedOps: errors.length },
        credits: await getBalance(owner),
        refunded,
        ...serializeProject(project),
      });
    }

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
