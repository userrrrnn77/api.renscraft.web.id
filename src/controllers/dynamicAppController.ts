// src/controllers/dynamicAppController.ts
import type { Request, Response } from "express";
import { DynamicDocument } from "../models/DynamicDocument.js";
import { DynamicApp } from "../models/DynamicApp.js";
import { DynamicCollection } from "../models/DynamicCollection.js";
import { Project } from "../models/Project.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { fail } from "../utils/apiError.js";
import { dynamicConfig } from "../config/env.js";
import {
  isValidFieldKey,
  isValidSlug,
  ALLOWED_FIELD_TYPES,
} from "../utils/dynamicValidators.js";
import { generateRenstraftSdk } from "../services/contract/dynamicSdk.js";
import mongoose from "mongoose";

const getOwnerId = (req: Request) => (req as any).user?.userId;

// ini di pake dimana aja ya bre?
const MAX_FIELD_LABEL = 100;
const MAX_OPTIONS = 50;
const MAX_OPTION_LEN = 100;

const validateFields = (fields: any, max: number): string | null => {
  if (!Array.isArray(fields) || fields.length > max)
    return "DYNAMIC_INVALID_FIELDS";

  const seen = new Set<string>();

  for (const f of fields) {
    if (!f || typeof f !== "object") return "DYNAMIC_INVALID_FIELDS";

    if (!isValidFieldKey(f.key)) return "DYNAMIC_INVALID_FIELD_KEY";
    if (seen.has(f.key)) return "DYNAMIC_DUPLICATE_FIELD_KEY";
    seen.add(f.key);

    if (
      typeof f.label !== "string" ||
      !f.label.trim() ||
      f.label.length > MAX_FIELD_LABEL
    ) {
      return "DYNAMIC_INVALID_LABEL";
    }

    if (f.required !== undefined && typeof f.required !== "boolean") {
      return "DYNAMIC_INVALID_FIELD_REQUIRED";
    }

    if (
      f.min !== undefined &&
      (typeof f.min !== "number" || !Number.isFinite(f.min))
    ) {
      return "DYNAMIC_INVALID_FIELD_MIN";
    }

    if (
      f.max !== undefined &&
      (typeof f.max !== "number" || !Number.isFinite(f.max))
    ) {
      return "DYNAMIC_INVALID_FIELD_MAX";
    }

    if (!ALLOWED_FIELD_TYPES.includes(f.type))
      return "DYNAMIC_INVALID_FIELD_TYPE";

    if (f.type === "select") {
      if (
        !Array.isArray(f.options) ||
        f.options.length === 0 ||
        f.options.length > MAX_OPTIONS
      ) {
        return "DYNAMIC_INVALID_FIELD_OPTIONS";
      }
      for (const opt of f.options) {
        if (
          typeof opt !== "string" ||
          !opt.trim() ||
          opt.length > MAX_OPTION_LEN
        ) {
          return "DYNAMIC_INVALID_FIELD_OPTIONS";
        }
      }
    }
  }

  return null;
};

// ─── Apps CRUD ──────────────────────────────────────────────────────────────

export const listApps = asyncHandler(async (req: Request, res: Response) => {
  const ownerId = getOwnerId(req);
  const apps = await DynamicApp.find({ ownerId })
    .sort({ createdAt: -1 })
    .lean();
  res.json({ apps });
});

export const createApp = asyncHandler(async (req: Request, res: Response) => {
  const ownerId = getOwnerId(req);
  const { sourceProjectId, slug } = req.body || {};

  if (!isValidSlug(slug)) {
    return fail(
      res,
      400,
      "DYNAMIC_INVALID_SLUG",
      {},
      "Slug is invalid or reserved",
    );
  }

  const cfg = dynamicConfig();
  const appCount = await DynamicApp.countDocuments({ ownerId });
  if (appCount >= cfg.maxAppsPerUser) {
    return fail(
      res,
      429,
      "DYNAMIC_TOO_MANY_APPS",
      { max: cfg.maxAppsPerUser },
      "Limit reached",
    );
  }

  const project = await Project.findOne({
    _id: sourceProjectId,
    owner: ownerId,
    status: "completed",
  }).lean();

  if (!project) {
    return fail(
      res,
      404,
      "DYNAMIC_PROJECT_NOT_FOUND",
      {},
      "Project not found or incomplete",
    );
  }

  try {
    const app = await DynamicApp.create({
      ownerId,
      sourceProjectId,
      slug,
      status: "draft",
    });
    res.status(201).json({ app });
  } catch (err: any) {
    if (err?.code === 11000) {
      return fail(res, 409, "DYNAMIC_SLUG_EXISTS", {}, "Slug is already taken");
    }
    throw err;
  }
});

export const getApp = asyncHandler(async (req: Request, res: Response) => {
  const ownerId = getOwnerId(req);
  const app = await DynamicApp.findOne({ _id: req.params.id, ownerId }).lean();
  if (!app) return fail(res, 404, "DYNAMIC_APP_NOT_FOUND", {}, "App not found");
  res.json({ app });
});

export const publishApp = asyncHandler(async (req: Request, res: Response) => {
  const ownerId = getOwnerId(req);
  const app = await DynamicApp.findOne({ _id: req.params.id, ownerId })
    .select("-publishedFiles")
    .lean();
  if (!app) return fail(res, 404, "DYNAMIC_APP_NOT_FOUND", {}, "App not found");
  if (app.status === "suspended" || app.status === "archived")
    return fail(res, 403, "DYNAMIC_APP_SUSPENDED", {}, "App is not available");

  const sourceProject = await Project.findOne({
    _id: app.sourceProjectId,
    owner: ownerId,
  }).lean();
  if (!sourceProject)
    return fail(
      res,
      404,
      "DYNAMIC_PROJECT_NOT_FOUND",
      {},
      "Source project missing",
    );

  const publishedFiles = {
    ...sourceProject.files,
    "/lib/renscraft.js": {
      content: generateRenstraftSdk(app.slug, true),
      hash: "server-owned-sdk",
    },
  };

  // filter status bikin guard-nya atomic, versi pakai $inc (bukan += 1)
  const updated = await DynamicApp.findOneAndUpdate(
    { _id: app._id, ownerId, status: { $in: ["draft", "published"] } },
    {
      $set: { publishedFiles, publishedAt: new Date(), status: "published" },
      $inc: { publishedVersion: 1 },
    },
    { returnDocument: "after" },
  )
    .select("-publishedFiles")
    .lean();
  if (!updated)
    return fail(res, 403, "DYNAMIC_APP_SUSPENDED", {}, "App is not available");

  res.json({ ok: true, app: updated });
});

// Tambahkan function baru ini di bagian bawah
export const getPublicApp = asyncHandler(
  async (req: Request, res: Response) => {
    const { slug } = req.params;

    // Hanya cari app yang statusnya 'published'
    const publicApp = await DynamicApp.findOne({
      slug,
      status: "published",
    }).lean();

    if (!publicApp) {
      return fail(
        res,
        404,
        "DYNAMIC_APP_NOT_FOUND",
        {},
        "App not found or not published yet",
      );
    }

    // Return data minimal (jangan bocorin ownerId, sourceProjectId, dll)
    res.json({
      slug: publicApp.slug,
      version: publicApp.publishedVersion,
      files: publicApp.publishedFiles,
    });
  },
);

export const unpublishApp = asyncHandler(
  async (req: Request, res: Response) => {
    const ownerId = getOwnerId(req);

    const app = await DynamicApp.findOneAndUpdate(
      { _id: req.params.id, ownerId, status: "published" },
      { $set: { status: "draft" } },
      { returnDocument: "after" },
    )
      .select("-publishedFiles")
      .lean();

    if (!app) {
      const existing = await DynamicApp.findOne({
        _id: req.params.id,
        ownerId,
      })
        .select("status")
        .lean();

      if (!existing)
        return fail(res, 404, "DYNAMIC_APP_NOT_FOUND", {}, "App not found");

      return fail(
        res,
        403,
        "DYNAMIC_APP_NOT_PUBLISHED",
        {},
        "App is not published",
      );
    }

    res.json({ ok: true, app });
  },
);

// ─── Collections CRUD ───────────────────────────────────────────────────────

export const listCollections = asyncHandler(
  async (req: Request, res: Response) => {
    const ownerId = getOwnerId(req);
    const app = await DynamicApp.findOne({ _id: req.params.id, ownerId })
      .select("_id")
      .lean();
    if (!app)
      return fail(res, 404, "DYNAMIC_APP_NOT_FOUND", {}, "App not found");

    const collections = await DynamicCollection.find({ appId: app._id }).lean();
    res.json({ collections });
  },
);

export const createCollection = asyncHandler(
  async (req: Request, res: Response) => {
    const ownerId = getOwnerId(req);
    const app = await DynamicApp.findOne({ _id: req.params.id, ownerId });
    if (!app)
      return fail(res, 404, "DYNAMIC_APP_NOT_FOUND", {}, "App not found");

    const { name, label, fields, policy, confirmPublic } = req.body || {};

    if (!isValidFieldKey(name)) {
      return fail(
        res,
        400,
        "DYNAMIC_INVALID_COLLECTION_NAME",
        {},
        "Invalid collection name",
      );
    }

    // label harus string kalau dikirim
    if (label !== undefined && typeof label !== "string") {
      return fail(
        res,
        400,
        "DYNAMIC_INVALID_LABEL",
        {},
        "Label must be a string",
      );
    }

    const cfg = dynamicConfig();

    // max = maxFieldsPerCollection (bukan maxCollectionsPerApp)
    const err = validateFields(fields, cfg.maxFieldsPerCollection);
    if (err) return fail(res, 400, err, {}, "Invalid fields");

    // policy + confirmPublic
    const normalizedPolicy = policy ?? "private";
    if (
      !["private", "public-read", "public-create-only"].includes(
        normalizedPolicy,
      )
    ) {
      return fail(res, 400, "DYNAMIC_INVALID_POLICY", {}, "Invalid policy");
    }
    if (normalizedPolicy.startsWith("public") && !confirmPublic) {
      return fail(
        res,
        400,
        "DYNAMIC_CONFIRM_PUBLIC_REQUIRED",
        {},
        "Set confirmPublic: true to enable public access",
      );
    }

    const colCount = await DynamicCollection.countDocuments({ appId: app._id });
    if (colCount >= cfg.maxCollectionsPerApp) {
      return fail(
        res,
        429,
        "DYNAMIC_TOO_MANY_COLLECTIONS",
        { max: cfg.maxCollectionsPerApp },
        "Limit reached",
      );
    }

    try {
      const col = await DynamicCollection.create({
        appId: app._id,
        name,
        label: label || name,
        fields,
        policy: normalizedPolicy,
        schemaVersion: 1,
      });
      res.status(201).json({ collection: col });
    } catch (err: any) {
      if (err?.code === 11000)
        return fail(
          res,
          409,
          "DYNAMIC_COLLECTION_EXISTS",
          {},
          "Collection name already exists",
        );
      throw err;
    }
  },
);

export const updateCollection = asyncHandler(
  async (req: Request, res: Response) => {
    const ownerId = getOwnerId(req);
    const app = await DynamicApp.findOne({ _id: req.params.id, ownerId })
      .select("_id")
      .lean();
    if (!app)
      return fail(res, 404, "DYNAMIC_APP_NOT_FOUND", {}, "App not found");

    const col = await DynamicCollection.findOne({
      _id: req.params.cid,
      appId: app._id,
    });
    if (!col)
      return fail(
        res,
        404,
        "DYNAMIC_COLLECTION_NOT_FOUND",
        {},
        "Collection not found",
      );

    const { label, fields, policy, confirmPublic } = req.body || {};

    if (label !== undefined) {
      if (typeof label !== "string") {
        return fail(
          res,
          400,
          "DYNAMIC_INVALID_LABEL",
          {},
          "Label must be a string",
        );
      }
      col.label = label;
    }

    if (fields !== undefined) {
      const err = validateFields(
        fields,
        dynamicConfig().maxFieldsPerCollection,
      );
      if (err) return fail(res, 400, err, {}, "Invalid fields");

      col.fields = fields;
      col.schemaVersion += 1; // Naikin versi tiap schema berubah
    }

    if (policy !== undefined) {
      if (!["private", "public-read", "public-create-only"].includes(policy)) {
        return fail(res, 400, "DYNAMIC_INVALID_POLICY", {}, "Invalid policy");
      }
      if (policy.startsWith("public") && !confirmPublic) {
        return fail(
          res,
          400,
          "DYNAMIC_CONFIRM_PUBLIC_REQUIRED",
          {},
          "Set confirmPublic: true to enable public access",
        );
      }
      col.policy = policy;
    }

    await col.save();
    res.json({ collection: col });
  },
);

export const deleteCollection = asyncHandler(
  async (req: Request, res: Response) => {
    const ownerId = getOwnerId(req);
    const app = await DynamicApp.findOne({ _id: req.params.id, ownerId })
      .select("_id")
      .lean();
    if (!app)
      return fail(res, 404, "DYNAMIC_APP_NOT_FOUND", {}, "App not found");

    const col = await DynamicCollection.findOneAndDelete({
      _id: req.params.cid,
      appId: app._id,
    });
    if (!col)
      return fail(
        res,
        404,
        "DYNAMIC_COLLECTION_NOT_FOUND",
        {},
        "Collection not found",
      );

    const deleted = await DynamicDocument.deleteMany({
      appId: app._id,
      collectionId: col._id,
    });

    if (deleted.deletedCount > 0) {
      await DynamicApp.updateOne({ _id: app._id }, [
        {
          $set: {
            docCount: {
              $max: [0, { $subtract: ["$docCount", deleted.deletedCount] }],
            },
          },
        },
      ]);
    }

    res.json({ ok: true });
  },
);

// ─── Documents (owner view) ────────────────────────────────────────────────

export const listDocuments = asyncHandler(
  async (req: Request, res: Response) => {
    const ownerId = getOwnerId(req);
    const app = await DynamicApp.findOne({ _id: req.params.id, ownerId })
      .select("_id")
      .lean();
    if (!app)
      return fail(res, 404, "DYNAMIC_APP_NOT_FOUND", {}, "App not found");

    const col = await DynamicCollection.findOne({
      _id: req.params.cid,
      appId: app._id,
    })
      .select("_id")
      .lean();
    if (!col)
      return fail(
        res,
        404,
        "DYNAMIC_COLLECTION_NOT_FOUND",
        {},
        "Collection not found",
      );

    const limit = Math.min(
      50,
      Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20),
    );
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
    const skip = (page - 1) * limit;

    const [documents, total] = await Promise.all([
      DynamicDocument.find({ appId: app._id, collectionId: col._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      DynamicDocument.countDocuments({
        appId: app._id,
        collectionId: col._id,
      }),
    ]);

    res.json({ documents, total, page, limit });
  },
);

export const deleteDocument = asyncHandler(
  async (req: Request, res: Response) => {
    const ownerId = getOwnerId(req);
    const app = await DynamicApp.findOne({ _id: req.params.id, ownerId })
      .select("_id")
      .lean();
    if (!app)
      return fail(res, 404, "DYNAMIC_APP_NOT_FOUND", {}, "App not found");

    const col = await DynamicCollection.findOne({
      _id: req.params.cid,
      appId: app._id,
    })
      .select("_id")
      .lean();
    if (!col)
      return fail(
        res,
        404,
        "DYNAMIC_COLLECTION_NOT_FOUND",
        {},
        "Collection not found",
      );

    if (!mongoose.isObjectIdOrHexString(req.params.docId)) {
      return fail(
        res,
        404,
        "DYNAMIC_DOCUMENT_NOT_FOUND",
        {},
        "Document not found",
      );
    }

    const result = await DynamicDocument.deleteOne({
      _id: req.params.docId,
      appId: app._id,
      collectionId: col._id,
    });

    if (result.deletedCount === 0) {
      return fail(
        res,
        404,
        "DYNAMIC_DOCUMENT_NOT_FOUND",
        {},
        "Document not found",
      );
    }

    // jangan pernah biarkan counter negatif
    await DynamicApp.updateOne(
      { _id: app._id, docCount: { $gt: 0 } },
      { $inc: { docCount: -1 } },
    );

    res.json({ ok: true });
  },
);
