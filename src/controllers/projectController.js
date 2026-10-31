// src/controllers/projectController.js

import mongoose from "mongoose";
import { BUSY_STATUSES, Project } from "../models/Project.js";
import { Brief } from "../models/Brief.js";
import { generateProject } from "../services/ai.js";
import {
  markUsageFailed,
  withUsageTracking,
} from "../services/usageTracker.js";
import { hashContent } from "../services/diff.js";
import { toSnapshot } from "../services/brief/briefFlow.js";
import {
  chargeCredits,
  creditCosts,
  refundCredits,
  refundHeld,
  rejectCharge,
  getBalance,
  exportCostFor,
} from "../services/credits.js";
import { objectKeyFor } from "../services/assetMirror.js";
import { getPublicUrl, isR2Configured, uploadObject } from "../utils/s3.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { fail } from "../utils/apiError.js";
import { buildQualityReport } from "../services/quality.js";
import { createHeartbeat } from "../services/heartbeat.js";

const MAX_PROMPT_LENGTH = 4000;
const MAX_ACTIVE_GENERATIONS = Number(process.env.MAX_ACTIVE_GENERATIONS) || 2;
const STALE_AFTER_MS =
  (Number(process.env.PROJECT_STALE_MINUTES) || 15) * 60 * 1000;
const MAX_FILES = 100;
const MAX_FILE_BYTES = 500 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_PATH_LENGTH = 200;

const isValidId = (id) =>
  typeof id === "string" && mongoose.isObjectIdOrHexString(id);

export const normalizePath = (p) => {
  const s = String(p).trim().replace(/\\/g, "/");
  return s.startsWith("/") ? s : `/${s}`;
};

const isSafePath = (p) =>
  p.length > 1 &&
  p.length <= MAX_PATH_LENGTH &&
  !p.endsWith("/") &&
  // eslint-disable-next-line no-control-regex
  !/[\u0000-\u001f]/.test(p) &&
  !p.split("/").some((seg) => seg === ".." || seg === ".");

export const parseFilesPayload = (files) => {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    return {
      code: "PROJECT_FILES_INVALID",
      params: {},
      error: "files must be an object of { path: content }",
    };
  }

  const entries = Object.entries(files);
  if (entries.length > MAX_FILES) {
    return {
      code: "PROJECT_TOO_MANY_FILES",
      params: { max: MAX_FILES },
      error: `Too many files (max ${MAX_FILES})`,
    };
  }

  const parsed = {};
  let total = 0;

  for (const [rawPath, content] of entries) {
    if (typeof content !== "string") continue;

    const path = normalizePath(rawPath);
    if (!isSafePath(path)) {
      return {
        code: "PROJECT_FILE_PATH_INVALID",
        params: { path: rawPath },
        error: `Invalid file path: ${rawPath}`,
      };
    }

    const size = Buffer.byteLength(content);
    if (size > MAX_FILE_BYTES) {
      return {
        code: "PROJECT_FILE_TOO_LARGE",
        params: { path },
        error: `${path} is too large`,
      };
    }

    total += size;
    if (total > MAX_TOTAL_BYTES) {
      return {
        code: "PROJECT_TOO_LARGE",
        params: {},
        error: "Project is too large",
      };
    }

    parsed[path] = { content, hash: hashContent(content) };
  }

  if (Object.keys(parsed).length === 0) {
    return {
      code: "PROJECT_FILES_INVALID",
      params: {},
      error: "files must contain at least one file with string content",
    };
  }

  return { files: parsed };
};

export const filesToObject = (files) => {
  const obj = {};
  for (const [path, entry] of Object.entries(files || {})) {
    obj[path] = entry?.content ?? "";
  }
  return obj;
};

export const serializeProject = (project) => ({
  _id: project._id,
  name: project.name,
  description: project.description,
  files: filesToObject(project.files),
  messages: project.messages,
  version: project.version,
  status: project.status,
  filesPlanned: project.filesPlanned,
  filesGenerated: project.filesGenerated,
  currentFile: project.currentFile,
  error: project.error,
  errorCode: project.errorCode ?? null,
  uploadedImages: project.uploadedImages || [],
  dataSpec: project.dataSpec ?? null,
  customSubdomain: project.customSubdomain ?? null,
  subdomainExpiresAt: project.subdomainExpiresAt ?? null,
  firstExportAt: project.firstExportAt ?? null,
  exportCost: exportCostFor(project.firstExportAt),
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  // F1: QualityReport. null untuk project lama yang belum pernah dinilai.
  quality: project.quality ?? null,
});

const notFound = (
  res,
  code = "PROJECT_NOT_FOUND",
  params = {},
  message = "Project not found",
) => fail(res, 404, code, params, message);

// ─── Stale settlement (dipanggil dari GET /:id) ────────────────────────────
const settleIfStale = async (project) => {
  if (!BUSY_STATUSES.includes(project.status)) return project;

  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  if (!project.updatedAt || project.updatedAt >= cutoff) return project;

  const wasRevising = project.status === "revising";
  const message = wasRevising
    ? "The revision timed out and was not applied. Please try again."
    : "Generation timed out. Please try again.";
  const errorCode = wasRevising ? "REVISION_TIMEOUT" : "GENERATION_TIMEOUT";

  const settled = await Project.findOneAndUpdate(
    { _id: project._id, status: project.status, updatedAt: { $lt: cutoff } },
    {
      $set: {
        status: wasRevising ? "completed" : "failed",
        error: message,
        errorCode,
        currentFile: null,
      },
      $push: {
        messages: {
          role: "assistant",
          content: message,
          timestamp: new Date(),
        },
      },
    },
    { returnDocument: "after" },
  );

  if (settled) await refundHeld(settled._id);
  return settled || project;
};

// ─── F2: recovery saat boot ────────────────────────────────────────────────
//
// Panggil dari server.js SETELAH DB ready. Menyelesaikan project yang
// nyangkut di busy karena proses sebelumnya mati (deploy / pm2 restart).
// Idempotent: filter updatedAt < cutoff mencegah dua instance mem-settle
// project yang sama.
export async function recoverStaleProjects(graceMs = 120_000) {
  const cutoff = new Date(Date.now() - graceMs);
  const stuck = await Project.find({
    status: { $in: BUSY_STATUSES },
    updatedAt: { $lt: cutoff },
  })
    .select("_id status")
    .lean();

  let recovered = 0;
  for (const p of stuck) {
    const wasRevising = p.status === "revising";
    const message = wasRevising
      ? "The revision timed out and was not applied. Please try again."
      : "Generation timed out. Please try again.";
    const settled = await Project.findOneAndUpdate(
      { _id: p._id, status: p.status, updatedAt: { $lt: cutoff } },
      {
        $set: {
          status: wasRevising ? "completed" : "failed",
          error: message,
          errorCode: wasRevising ? "REVISION_TIMEOUT" : "GENERATION_TIMEOUT",
          currentFile: null,
        },
        $push: {
          messages: {
            role: "assistant",
            content: message,
            timestamp: new Date(),
          },
        },
      },
      { returnDocument: "after" },
    );
    if (settled) {
      await refundHeld(settled._id);
      recovered++;
    }
  }
  return recovered;
}

// ─── POST /api/projects ─────────────────────────────────────────────────────
export const createProject = asyncHandler(async (req, res) => {
  const owner = req.user.userId;
  const briefId = req.body?.briefId;

  let briefDoc = null;
  let prompt;

  if (briefId !== undefined && briefId !== null) {
    if (!isValidId(briefId))
      return notFound(
        res,
        "PROJECT_BRIEF_NOT_FOUND",
        {},
        "Brief tidak ditemukan atau sudah kedaluwarsa",
      );
    briefDoc = await Brief.findOne({
      _id: briefId,
      owner,
      status: "open",
    }).lean();
    if (!briefDoc)
      return notFound(
        res,
        "PROJECT_BRIEF_NOT_FOUND",
        {},
        "Brief tidak ditemukan atau sudah kedaluwarsa",
      );
    prompt = briefDoc.prompt;
  } else {
    prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (!prompt)
      return fail(
        res,
        400,
        "PROJECT_PROMPT_REQUIRED",
        {},
        "prompt is required",
      );
    if (prompt.length > MAX_PROMPT_LENGTH)
      return fail(
        res,
        400,
        "PROJECT_PROMPT_TOO_LONG",
        { max: MAX_PROMPT_LENGTH },
        `prompt is too long (max ${MAX_PROMPT_LENGTH} characters)`,
      );
  }

  const activeCount = await Project.countDocuments({
    owner,
    status: { $in: ["pending", "generating"] },
    updatedAt: { $gte: new Date(Date.now() - STALE_AFTER_MS) },
  });
  if (activeCount >= MAX_ACTIVE_GENERATIONS) {
    return fail(
      res,
      429,
      "PROJECT_TOO_MANY_ACTIVE",
      { max: MAX_ACTIVE_GENERATIONS },
      "You already have websites being generated. Please wait until they finish.",
    );
  }

  const cost = creditCosts().generate;
  const charge = await chargeCredits(owner, cost);
  if (!charge.ok) {
    rejectCharge(res, charge);
    return;
  }

  let snapshot = null;
  if (briefDoc) {
    let claimed;
    try {
      claimed = await Brief.findOneAndUpdate(
        { _id: briefDoc._id, owner, status: "open" },
        { $set: { status: "used" } },
        { returnDocument: "after" },
      );
    } catch (err) {
      await refundCredits(owner, cost);
      throw err;
    }
    if (!claimed) {
      await refundCredits(owner, cost);
      return fail(res, 409, "PROJECT_BRIEF_USED", {}, "Brief sudah dipakai");
    }
    snapshot = toSnapshot(claimed.toObject());
  }

  let project;
  try {
    project = await Project.create({
      name: "Planning Project...",
      description: prompt,
      files: {},
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: "Planning project structure..." },
      ],
      version: 0,
      owner,
      status: "pending",
      filesPlanned: [],
      filesGenerated: [],
      currentFile: null,
      error: null,
      errorCode: null,
      creditsHeld: cost,
      brief: snapshot,
    });
  } catch (err) {
    await refundCredits(owner, cost);
    if (briefDoc)
      await Brief.updateOne(
        { _id: briefDoc._id, owner },
        { $set: { status: "open" } },
      ).catch(() => {});
    throw err;
  }

  const projectId = project._id.toString();
  withUsageTracking(
    "generate",
    () => runBackgroundGeneration(projectId, prompt, snapshot),
    { projectId, category: snapshot?.category },
  ).catch((err) => {
    console.error(
      `[Background AI] Fatal generation error for project ${project._id}: `,
      err,
    );
  });

  res
    .status(201)
    .json({ ...serializeProject(project), credits: charge.balance });
});

// ─── Generation background (F1 + F2) ───────────────────────────────────────
const runBackgroundGeneration = async (projectId, prompt, brief = null) => {
  const heartbeat = createHeartbeat(projectId);
  heartbeat.start();

  let writeQueue = Promise.resolve();
  const enqueue = (fn) => {
    const run = writeQueue.then(fn);
    writeQueue = run.catch(() => {});
    return run;
  };

  const savedPaths = new Set();

  try {
    console.log(`[Background AI] Starting generation for project ${projectId}`);

    const projectForUploads = await Project.findById(projectId)
      .select("uploadedImages")
      .lean();
    const uploadedImages = projectForUploads?.uploadedImages || [];

    const result = await generateProject(
      prompt,
      {
        onPlan: async (plan) => {
          const planned = plan.files.map((f) => ({
            path: normalizePath(f.path),
            description: f.description,
          }));
          const fileList = planned
            .map((f) => `- \`${f.path}\`: ${f.description}`)
            .join("\n");
          await Project.findByIdAndUpdate(projectId, {
            name: plan.projectName || "Generated Project",
            status: "generating",
            filesPlanned: planned,
            $push: {
              messages: {
                role: "assistant",
                content: `Planned website structure:\n${fileList}`,
                timestamp: new Date(),
              },
            },
          });
        },
        onFileStart: async (path) => {
          await Project.findByIdAndUpdate(projectId, {
            currentFile: normalizePath(path),
          });
        },
        onFileComplete: (path, code) =>
          enqueue(async () => {
            const key = normalizePath(path);
            const project = await Project.findById(projectId);
            if (!project) return;
            project.files = project.files || {};
            project.files[key] = { content: code, hash: hashContent(code) };
            if (!(project.filesGenerated || []).includes(key)) {
              project.filesGenerated = [...(project.filesGenerated || []), key];
            }
            project.messages.push({
              role: "assistant",
              content: `Created file ${key}`,
              timestamp: new Date(),
            });
            project.currentFile = null;
            project.markModified("files");
            await project.save();
            savedPaths.add(key);
          }),
      },
      { brief: brief ?? undefined, uploadedImages },
    );

    // Pastikan semua write dari onFileComplete selesai sebelum kita baca state
    await writeQueue;

    // Baca state terkini (bukan snapshot lama). .lean() biar murah dan nggak
    // ada method Mongoose yang bisa mengubah objek di memori.
    const project = await Project.findById(projectId).lean();
    if (!project) return;

    // Clone, jangan mutasi objek hasil .lean()
    const mergedFiles = { ...(project.files || {}) };
    const failedPaths = [];

    for (const [rawPath, code] of Object.entries(result.fixed || {})) {
      const key = normalizePath(rawPath);
      mergedFiles[key] = { content: code, hash: hashContent(code) };
    }

    for (const [rawPath, code] of Object.entries(result.files || {})) {
      const key = normalizePath(rawPath);
      if (!Object.hasOwn(mergedFiles, key)) {
        mergedFiles[key] = { content: code, hash: hashContent(code) };
      }
      if (!savedPaths.has(key)) failedPaths.push(key);
    }

    // ─── F1: placeholder → warning ──────────────────────────────────────
    const qualityIssues = failedPaths.map((path) => ({
      code: "PLACEHOLDER_FILE",
      severity: "warning",
      stage: "static",
      path,
      message: `${path} was not generated and was replaced with a placeholder.`,
    }));

    // F3: bawa issue dari finalize (blocking/warning, sudah berbentuk
    // QualityIssue) ke QualityReport supaya F1 bisa gate publish/export.
    if (Array.isArray(result.finalizeIssues)) {
      for (const i of result.finalizeIssues) {
        qualityIssues.push({
          code: i.code,
          severity: i.severity,
          stage: i.stage,
          path: i.path,
          message: i.message,
          autoFixed: !!i.autoFixed,
        });
      }
    }

    // F4: budget / semaphore
    if (result.budgetExceeded) {
      qualityIssues.push({
        code: "BUDGET_EXCEEDED",
        severity: "warning",
        stage: "static",
        message: "Generation budget was exceeded. Some files are placeholders.",
      });
    }
    if (result.semaphoreTimedOut) {
      qualityIssues.push({
        code: "SEMAPHORE_TIMEOUT",
        severity: "warning",
        stage: "static",
        message: "Generation timed out waiting for an AI slot.",
      });
    }
    if (result.budget?.exceeded && !result.budgetExceeded) {
      console.warn(
        `[Budget] Limits reached in log mode (not enforced). Summary: ${JSON.stringify(result.budget)}`,
      );
    }

    // F5: bawa issue dari QA gate. Di mode "shadow", pemanggil sudah memastikan
    // ── F5: QA gate ──────────────────────────────────────────────────────
    let gateIssues = [];
    let gateStages = {};
    let gateMode = "off";
    try {
      const gate = await runQualityGate(finalFiles, contract);
      gateMode = gate.mode;
      gateStages = gate.stages;
      gateIssues = gate.reportable ? gate.issues : [];

      const fmt = (i) =>
        `${i.code}${i.path ? ` @ ${i.path}` : ""}: ${i.message}`;

      if (gate.mode === "shadow") {
        // Shadow: cuma blocking yang di-log. Warning (RESOURCE_BLOCKED, dll)
        // diabaikan — kalau nanti di-enforce pun gak akan ngeblok.
        if (gate.loggable.length > 0) {
          console.log(
            `[QA] shadow: ${gate.loggable.length} blocking issue(s) (not applied):\n  - ` +
              gate.loggable.map(fmt).join("\n  - "),
          );
        } else if (gate.issues.length > 0) {
          console.log(
            `[QA] shadow: passed (${gate.issues.length} warning(s) ignored)`,
          );
        } else {
          console.log(`[QA] shadow: passed`);
        }
      } else if (gate.issues.length === 0) {
        console.log(`[QA] ${gate.mode}: passed`);
      } else {
        const blocking = gate.issues.filter((i) => i.severity === "blocking");
        console.log(
          `[QA] ${gate.mode}: ${gate.issues.length} issue(s), ${blocking.length} blocking:\n  - ` +
            gate.issues.map(fmt).join("\n  - "),
        );
      }
    } catch (err) {
      console.error("[QA] crashed, skipping gate:", err);
    }

    const quality = buildQualityReport(qualityIssues, { version: 1 });

    const completionMessage =
      failedPaths.length === 0
        ? "Website generation complete! You can view and edit files"
        : `Website generated, but ${failedPaths.length} file(s) could not be generated and were replaced with placeholders: ${failedPaths.join(", ")}. Ask the AI to rewrite them.`;

    // ─── F2: CAS save — jangan pernah nimpa project yang sudah di-settle ──
    // Filter { status: "generating" } memastikan:
    //   - settleIfStale sudah menandai failed → CAS tidak match, hasil dibuang
    //   - pm2 restart lalu recovery boot menandai failed → CAS tidak match
    //   - 2 instance paralel → cuma satu yang menang
    const settled = await Project.findOneAndUpdate(
      { _id: projectId, status: "generating" },
      {
        $set: {
          files: mergedFiles,
          status: "completed",
          version: 1,
          currentFile: null,
          error: null,
          errorCode: null,
          creditsHeld: 0,
          dataSpec: result.dataSpec ?? null,
          quality,
        },
        $push: {
          messages: {
            role: "assistant",
            content: completionMessage,
            timestamp: new Date(),
          },
        },
      },
      { returnDocument: "after" },
    );

    if (!settled) {
      console.warn(
        `[Background AI] Project ${projectId} was settled externally (status != generating). Discarding result.`,
      );
    }
  } catch (err) {
    markUsageFailed(err);
    console.error(
      `[Background AI] Fatal generation error for project ${projectId}: `,
      err,
    );

    const failed = await Project.findOneAndUpdate(
      { _id: projectId, status: { $in: BUSY_STATUSES } },
      {
        $set: {
          status: "failed",
          error: err.message,
          errorCode: "GENERATION_FAILED",
          currentFile: null,
        },
        $push: {
          messages: {
            role: "assistant",
            content: `Generation Failed: ${err.message}`,
            timestamp: new Date(),
          },
        },
      },
    );

    if (failed) await refundHeld(projectId);
    else
      console.warn(
        `[Background AI] Project ${projectId} already settled, no refund needed`,
      );
  } finally {
    heartbeat.stop();
  }
};

// ─── GET /api/projects ──────────────────────────────────────────────────────
export const listProjects = asyncHandler(async (req, res) => {
  const projects = await Project.find(
    { owner: req.user.userId },
    {
      name: 1,
      description: 1,
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      published: 1,
      status: 1,
      errorCode: 1,
      customSubdomain: 1,
      subdomainExpiresAt: 1,
      quality: 1,
    },
  ).sort({ updatedAt: -1 });

  res.status(200).json(projects);
});

// ─── GET /api/projects/:id ──────────────────────────────────────────────────
export const getProject = asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return notFound(res);

  let project = await Project.findOne({
    _id: req.params.id,
    owner: req.user.userId,
  });
  if (!project) return notFound(res);

  project = await settleIfStale(project);
  res.status(200).json(serializeProject(project));
});

// ─── DELETE /api/projects/:id ───────────────────────────────────────────────
export const deleteProject = asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return notFound(res);

  const result = await Project.findOneAndDelete({
    _id: req.params.id,
    owner: req.user.userId,
  });
  if (!result) return notFound(res);

  const stuck =
    BUSY_STATUSES.includes(result.status) &&
    (!result.updatedAt ||
      result.updatedAt < new Date(Date.now() - STALE_AFTER_MS));

  if (stuck) await refundCredits(result.owner, result.creditsHeld || 0);

  res.json({ success: true });
});

// ─── PUT /api/projects/:id/files ────────────────────────────────────────────
export const updateProjectFiles = asyncHandler(async (req, res) => {
  const parsed = parseFilesPayload(req.body?.files);
  if (parsed.error)
    return fail(res, 400, parsed.code, parsed.params, parsed.error);

  if (!isValidId(req.params.id)) return notFound(res);

  const project = await Project.findOneAndUpdate(
    {
      _id: req.params.id,
      owner: req.user.userId,
      status: { $nin: BUSY_STATUSES },
    },
    { $set: { files: parsed.files } },
    { returnDocument: "after" },
  );

  if (!project) {
    const exists = await Project.exists({
      _id: req.params.id,
      owner: req.user.userId,
    });
    if (!exists) return notFound(res);
    return fail(
      res,
      409,
      "PROJECT_BUSY",
      {},
      "The project is still being generated or revised. Try again when it finishes.",
    );
  }

  res.json(serializeProject(project));
});

// ─── POST /api/projects/:id/publish (F1 guard) ─────────────────────────────
export const publishProject = asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return notFound(res);

  // F1: blokir kalau quality check sudah menandai failed
  const existing = await Project.findOne({
    _id: req.params.id,
    owner: req.user.userId,
  })
    .select("quality")
    .lean();
  if (!existing) return notFound(res);
  if (existing.quality?.status === "failed") {
    return fail(
      res,
      409,
      "QUALITY_FAILED",
      {},
      "This project failed the quality check and cannot be published. Try regenerating it.",
    );
  }

  let project;
  try {
    project = await Project.findOneAndUpdate(
      { _id: req.params.id, owner: req.user.userId, status: "completed" },
      { $set: { published: true } },
      { returnDocument: "after" },
    );
  } catch (err) {
    if (err?.code === 11000)
      return fail(
        res,
        409,
        "PROJECT_PUBLISH_NAME_TAKEN",
        {},
        "This website name is already used by another published website. Rename it first.",
      );
    throw err;
  }

  if (!project) {
    const exists = await Project.exists({
      _id: req.params.id,
      owner: req.user.userId,
    });
    if (!exists) return notFound(res);
    return fail(
      res,
      409,
      "PROJECT_PUBLISH_NOT_COMPLETED",
      {},
      "Only completed projects can be published.",
    );
  }

  res.json({ success: true, published: project.published, name: project.name });
});

// ─── GET /api/projects/public/:name ─────────────────────────────────────────
const PUBLIC_NOT_AVAILABLE =
  "This website is not available or is not published yet.";

export const getPublicProject = asyncHandler(async (req, res) => {
  const name =
    typeof req.params.name === "string" ? req.params.name.trim() : "";
  if (!name || name.length > 200)
    return notFound(
      res,
      "PROJECT_PUBLIC_NOT_AVAILABLE",
      {},
      PUBLIC_NOT_AVAILABLE,
    );

  const project = await Project.findOne({ name, published: true })
    .collation({ locale: "en", strength: 2 })
    .lean();

  if (!project)
    return notFound(
      res,
      "PROJECT_PUBLIC_NOT_AVAILABLE",
      {},
      PUBLIC_NOT_AVAILABLE,
    );

  res.json({
    _id: project._id,
    name: project.name,
    files: filesToObject(project.files),
    version: project.version,
  });
});

export const getAllPublicProjects = async (req, res) => {
  try {
    const allProjects = await Project.find({ published: true });
    if (!allProjects) return notFound(res, "PROJECT_NOT_FOUND");
    return res.status(200).json({ data: allProjects });
  } catch (err) {
    console.error("[Error] Internal Server Error: ", err);
    res
      .status(500)
      .json({ error: "Internal server error", code: "INTERNAL_ERROR" });
  }
};

// ─── POST /api/projects/:id/images ──────────────────────────────────────────
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export const uploadProjectImage = asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return notFound(res);
  if (!isR2Configured())
    return fail(
      res,
      503,
      "PROJECT_IMAGE_R2_MISSING",
      {},
      "Image upload is not configured (R2 missing).",
    );

  const buffer = req.body;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0)
    return fail(res, 400, "PROJECT_IMAGE_EMPTY", {}, "Empty image body");
  if (buffer.length > MAX_UPLOAD_BYTES) {
    const max = Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024);
    return fail(
      res,
      413,
      "PROJECT_IMAGE_TOO_LARGE",
      { max },
      `Image too large (max ${max}MB)`,
    );
  }

  const contentType = (req.headers["content-type"] || "").split(";")[0].trim();
  const key = objectKeyFor(buffer, contentType);
  if (!key)
    return fail(
      res,
      400,
      "PROJECT_IMAGE_UNSUPPORTED",
      {},
      "Unsupported image type. Use JPEG, PNG, WebP, GIF, or AVIF.",
    );

  let url;
  try {
    url = await uploadObject(key, buffer, contentType);
  } catch (err) {
    console.error(
      `[Upload] R2 failed for project ${req.params.id}: ${err.message}`,
    );
    return fail(
      res,
      502,
      "PROJECT_IMAGE_UPLOAD_FAILED",
      {},
      "Upload to storage failed, try again.",
    );
  }

  const name =
    typeof req.headers["x-file-name"] === "string"
      ? decodeURIComponent(req.headers["x-file-name"]).slice(0, 120)
      : "upload";

  const project = await Project.findOneAndUpdate(
    { _id: req.params.id, owner: req.user.userId },
    { $push: { uploadedImages: { url, name, addedAt: new Date() } } },
    { returnDocument: "after", projection: { uploadedImages: 1 } },
  );
  if (!project) return notFound(res);

  res.status(201).json({
    url,
    name,
    total: project.uploadedImages.length,
    uploadedImages: project.uploadedImages,
  });
});

// ─── DELETE /api/projects/:id/images ────────────────────────────────────────
export const deleteProjectImage = asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return notFound(res);

  const url = typeof req.body?.url === "string" ? req.body.url : "";
  if (!url)
    return fail(res, 400, "PROJECT_IMAGE_URL_REQUIRED", {}, "url is required");

  const project = await Project.findOneAndUpdate(
    { _id: req.params.id, owner: req.user.userId },
    { $pull: { uploadedImages: { url } } },
    { returnDocument: "after", projection: { uploadedImages: 1 } },
  );
  if (!project) return notFound(res);

  res.json({ uploadedImages: project.uploadedImages });
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── FITUR PREMIUM SUBDOMAIN ───
// ═══════════════════════════════════════════════════════════════════════════
const SUBDOMAIN_COST = 100;
const RESERVED_SLUGS = new Set([
  "www",
  "api",
  "admin",
  "app",
  "dashboard",
  "mail",
  "ftp",
  "static",
  "assets",
  "cdn",
  "docs",
]);
const SUBDOMAIN_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const isSubdomainActive = (project) => {
  return (
    project.customSubdomain &&
    project.subdomainExpiresAt &&
    project.subdomainExpiresAt > new Date()
  );
};

export const claimSubdomain = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const owner = req.user.userId;

  const rawSlug =
    typeof req.body?.slug === "string"
      ? req.body.slug.trim().toLowerCase()
      : "";

  if (
    !SUBDOMAIN_REGEX.test(rawSlug) ||
    rawSlug.length < 3 ||
    rawSlug.length > 30
  ) {
    return fail(
      res,
      400,
      "INVALID_SUBDOMAIN",
      {},
      "Slug harus 3-30 karakter (huruf kecil, angka, strip).",
    );
  }

  if (RESERVED_SLUGS.has(rawSlug)) {
    return fail(
      res,
      400,
      "SUBDOMAIN_RESERVED",
      {},
      "Slug ini tidak boleh dipakai.",
    );
  }

  const existing = await Project.findOne({
    customSubdomain: rawSlug,
    subdomainExpiresAt: { $gt: new Date() },
  }).lean();

  if (existing) {
    return fail(
      res,
      409,
      "SUBDOMAIN_TAKEN",
      {},
      "Subdomain ini sudah dipakai orang lain.",
    );
  }

  if (!isValidId(id)) return notFound(res);

  const project = await Project.findOne({ _id: id, owner }).lean();
  if (!project) return notFound(res);

  if (project.status !== "completed") {
    return fail(
      res,
      400,
      "PROJECT_NOT_COMPLETED",
      {},
      "Website harus selesai di-generate.",
    );
  }

  const charge = await chargeCredits(owner, SUBDOMAIN_COST);
  if (!charge.ok) return rejectCharge(res, charge);

  try {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const updated = await Project.findByIdAndUpdate(
      id,
      {
        $set: {
          customSubdomain: rawSlug,
          subdomainExpiresAt: expiresAt,
          published: true,
        },
      },
      { returnDocument: "after" },
    );

    res.json({
      success: true,
      message: "Subdomain berhasil diklaim untuk 30 hari!",
      url: `https://${rawSlug}.renscraft.cyou`,
      expiresAt: expiresAt,
      credits: await getBalance(owner),
      project: serializeProject(updated),
    });
  } catch (err) {
    await refundCredits(owner, SUBDOMAIN_COST);
    if (err?.code === 11000) {
      return fail(
        res,
        409,
        "SUBDOMAIN_TAKEN",
        {},
        "Subdomain baru saja dipakai orang lain.",
      );
    }
    throw err;
  }
});

export const renewSubdomain = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const owner = req.user.userId;

  if (!isValidId(id)) return notFound(res);

  const project = await Project.findOne({ _id: id, owner }).lean();
  if (!project) return notFound(res);

  if (!project.customSubdomain) {
    return fail(
      res,
      400,
      "NO_SUBDOMAIN",
      {},
      "Klaim subdomain terlebih dahulu.",
    );
  }

  const charge = await chargeCredits(owner, SUBDOMAIN_COST);
  if (!charge.ok) return rejectCharge(res, charge);

  try {
    let baseDate =
      project.subdomainExpiresAt && project.subdomainExpiresAt > new Date()
        ? project.subdomainExpiresAt
        : new Date();
    const newExpiresAt = new Date(baseDate);
    newExpiresAt.setDate(newExpiresAt.getDate() + 30);

    const updated = await Project.findByIdAndUpdate(
      id,
      { $set: { subdomainExpiresAt: newExpiresAt, published: true } },
      { returnDocument: "after" },
    );

    res.json({
      success: true,
      message: "Subdomain diperpanjang 30 hari!",
      url: `https://${project.customSubdomain}.renscraft.cyou`,
      expiresAt: newExpiresAt,
      credits: await getBalance(owner),
      project: serializeProject(updated),
    });
  } catch (err) {
    await refundCredits(owner, SUBDOMAIN_COST);
    throw err;
  }
});

export const releaseSubdomain = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const owner = req.user.userId;

  if (!isValidId(id)) return notFound(res);

  const project = await Project.findOneAndUpdate(
    { _id: id, owner, customSubdomain: { $exists: true, $ne: null } },
    {
      $set: { published: false },
      $unset: { customSubdomain: 1, subdomainExpiresAt: 1 },
    },
    { returnDocument: "after" },
  );

  if (!project)
    return fail(
      res,
      404,
      "PROJECT_NOT_FOUND",
      {},
      "Project tidak ditemukan atau tidak punya subdomain.",
    );

  res.json({ success: true, message: "Subdomain berhasil dilepas." });
});

export const getPublicProjectBySubdomain = asyncHandler(async (req, res) => {
  const slug = String(req.params.slug || "")
    .trim()
    .toLowerCase();

  if (!slug || slug.length > 30) {
    return notFound(
      res,
      "PROJECT_PUBLIC_NOT_AVAILABLE",
      {},
      "Website tidak tersedia.",
    );
  }

  const project = await Project.findOne({ customSubdomain: slug }).lean();

  if (!project || !project.published || !isSubdomainActive(project)) {
    return notFound(
      res,
      "PROJECT_PUBLIC_NOT_AVAILABLE",
      {},
      "Website tidak ditemukan, belum dipublish, atau langganan subdomain sudah habis.",
    );
  }

  res.json({
    _id: project._id,
    name: project.name,
    files: filesToObject(project.files),
    version: project.version,
  });
});

export const exportProject = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const owner = req.user.userId;

  if (!isValidId(id)) return notFound(res);

  const project = await Project.findOne({ _id: id, owner }).lean();
  if (!project) return notFound(res);

  if (project.status !== "completed") {
    return fail(
      res,
      400,
      "PROJECT_NOT_COMPLETED",
      {},
      "Website harus selesai di-generate sebelum di-export.",
    );
  }

  const isFirstExport = !project.firstExportAt;
  const cost = exportCostFor(project.firstExportAt);

  const charge = await chargeCredits(owner, cost);
  if (!charge.ok) {
    rejectCharge(res, charge);
    return;
  }

  // Atomic: cuma set kalau memang belum pernah export.
  if (isFirstExport) {
    await Project.updateOne(
      { _id: id, owner, firstExportAt: null },
      { $set: { firstExportAt: new Date() } },
    ).catch(() => {});
  }

  res.json({
    success: true,
    credits: charge.balance,
    cost,
    firstExport: isFirstExport,
    message: isFirstExport
      ? `Export pertama: ${cost} kredit. Export berikutnya cuma ${creditCosts().exportCostRepeat} kredit.`
      : `Berhasil memotong ${cost} kredit untuk export.`,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ─── F6: PROJECT VERSIONS ───
// ═══════════════════════════════════════════════════════════════════════════

export const listProjectVersions = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return notFound(res);

  const exists = await Project.exists({ _id: id, owner: req.user.userId });
  if (!exists) return notFound(res);

  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const { listProjectVersions: listFn } =
    await import("../services/projectVersions.js");
  const versions = await listFn(id, { limit });
  res.json({ versions });
});

export const restoreProjectVersion = asyncHandler(async (req, res) => {
  const { id, v } = req.params;
  if (!isValidId(id)) return notFound(res);

  const targetVersion = Number.parseInt(v, 10);
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    return fail(res, 400, "INVALID_VERSION", {}, "Invalid version number");
  }

  const project = await Project.findOne({ _id: id, owner: req.user.userId });
  if (!project) return notFound(res);

  if (BUSY_STATUSES.includes(project.status)) {
    return fail(
      res,
      409,
      "PROJECT_BUSY",
      {},
      "The project is busy. Try again when it finishes.",
    );
  }

  const { getProjectVersion, saveProjectVersion } =
    await import("../services/projectVersions.js");
  const snapshot = await getProjectVersion(id, targetVersion);
  if (!snapshot) {
    return fail(res, 404, "VERSION_NOT_FOUND", {}, "Version not found");
  }

  // Restore = buat versi baru dengan isi snapshot. Non-destruktif: versi
  // lama tetap ada (bisa restore balik ke versi yang tadi).
  const newVersion = project.version + 1;
  await saveProjectVersion({
    projectId: project._id,
    version: newVersion,
    files: snapshot.files,
    prompt: `restore v${targetVersion}`,
    quality: snapshot.quality ?? null,
  });

  project.files = snapshot.files;
  project.markModified("files");
  project.version = newVersion;
  project.status = "completed";
  project.error = null;
  project.errorCode = null;
  project.messages.push({
    role: "assistant",
    content: `Project restored to version ${targetVersion} (new version: ${newVersion}).`,
    timestamp: new Date(),
  });

  await project.save();
  res.json(serializeProject(project));
});
