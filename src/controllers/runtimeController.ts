// src/controllers/runtimeController.ts
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { DynamicApp } from "../models/DynamicApp.js";
import {
  DynamicCollection,
  type IDynamicField,
} from "../models/DynamicCollection.js";
import { DynamicDocument } from "../models/DynamicDocument.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { fail } from "../utils/apiError.js";
import { dynamicConfig } from "../config/env.js";

// Helper: Validasi data yang masuk dari luar
function validatePayload(
  fields: IDynamicField[],
  payload: any,
  isPartial = false,
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Payload must be an object" };
  }

  const cleanData: Record<string, any> = {};
  const allowedKeys = new Set(fields.map((f) => f.key));

  // 1. Tolak key yang tidak terdaftar di schema
  // 1. Tolak key yang tidak terdaftar di schema
  for (const key of Object.keys(payload)) {
    if (
      key.startsWith("$") ||
      key.includes(".") ||
      key === "__proto__" ||
      key === "prototype" || 
      key === "constructor"
    ) {
      return { ok: false, error: `Invalid key format: ${key}` };
    }
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `Unknown field: ${key}` };
    }
  }

  // 2. Cek required fields (kalau bukan partial update)
  if (!isPartial) {
    for (const f of fields) {
      if (f.required && payload[f.key] === undefined) {
        return { ok: false, error: `Field '${f.key}' is required` };
      }
    }
  }

  // 3. Cek tipe data & batasan
  for (const f of fields) {
    const val = payload[f.key];
    if (val === undefined) continue;

    if (val === null) {
      cleanData[f.key] = null;
      continue;
    }

    switch (f.type) {
      case "string":
        if (typeof val !== "string")
          return { ok: false, error: `Field '${f.key}' must be string` };
        if (val.length > 2000)
          return { ok: false, error: `Field '${f.key}' too long (max 2000)` };
        cleanData[f.key] = val;
        break;
      case "number":
        if (typeof val !== "number" || isNaN(val))
          return { ok: false, error: `Field '${f.key}' must be number` };
        if (f.min !== undefined && val < f.min)
          return { ok: false, error: `Field '${f.key}' below min` };
        if (f.max !== undefined && val > f.max)
          return { ok: false, error: `Field '${f.key}' above max` };
        cleanData[f.key] = val;
        break;
      case "boolean":
        if (typeof val !== "boolean")
          return { ok: false, error: `Field '${f.key}' must be boolean` };
        cleanData[f.key] = val;
        break;
      case "date":
        const d = new Date(val);
        if (isNaN(d.getTime()))
          return { ok: false, error: `Field '${f.key}' must be valid date` };
        cleanData[f.key] = d;
        break;
      case "select":
        if (typeof val !== "string")
          return { ok: false, error: `Field '${f.key}' must be string` };
        if (f.options && !f.options.includes(val))
          return { ok: false, error: `Field '${f.key}' invalid option` };
        cleanData[f.key] = val;
        break;
      default:
        return { ok: false, error: `Unsupported type for '${f.key}'` };
    }
  }

  return { ok: true, data: cleanData };
}

// Helper: Cari App & Collection berdasarkan slug
async function resolveAppAndCollection(slug: string, colName: string) {
  const app = await DynamicApp.findOne({ slug, status: "published" });
  if (!app) return null;

  const col = await DynamicCollection.findOne({
    appId: app._id,
    name: colName,
  });
  if (!col) return null;

  return { app, col };
}

// ─── Endpoints ──────────────────────────────────────────────────────────────

export const createDocument = asyncHandler(
  async (req: Request, res: Response) => {
    // ✅ FIX: kasih default "" biar TypeScript gak protes
    const { slug = "", name = "" } = req.params;
    const resolved = await resolveAppAndCollection(slug, name);

    // 404 anti-bocor: app/col gak ada atau bukan hak akses lu, hasilnya sama.
    if (!resolved)
      return fail(res, 404, "RUNTIME_NOT_FOUND", {}, "Collection not found");

    const { app, col } = resolved;
    if (col.policy !== "public-create-only") {
      return fail(
        res,
        403,
        "RUNTIME_FORBIDDEN",
        {},
        "This collection is not open for public submissions",
      );
    }

    // Validasi Payload
    const validation = validatePayload(col.fields, req.body);

    if (!validation.ok)
      return fail(res, 400, "RUNTIME_INVALID_PAYLOAD", {}, validation.error);

    // Cek Size Limit Payload
    const size = Buffer.byteLength(JSON.stringify(validation.data));
    if (size > dynamicConfig().maxDocBytes) {
      return fail(
        res,
        413,
        "RUNTIME_PAYLOAD_TOO_LARGE",
        { max: dynamicConfig().maxDocBytes },
        "Document too large",
      );
    }

    // 1. Atomic Kuota Check
    const cfg = dynamicConfig();
    const updatedApp = await DynamicApp.findOneAndUpdate(
      { _id: app._id, docCount: { $lt: cfg.maxDocsPerApp } },
      { $inc: { docCount: 1 } },
      { returnDocument: "after", projection: { docCount: 1 } },
    );

    if (!updatedApp) {
      return fail(
        res,
        429,
        "RUNTIME_QUOTA_EXCEEDED",
        { max: cfg.maxDocsPerApp },
        "Collection quota reached",
      );
    }

    // 2. Simpan Dokumen
    try {
      const doc = await DynamicDocument.create({
        appId: app._id,
        collectionId: col._id,
        data: validation.data,
        schemaVersion: col.schemaVersion,
      });
      // Response create cuma id (aman)
      return res.status(201).json({ ok: true, id: doc._id });
    } catch (err) {
      // Rollback kuota kalau insert gagal
      await DynamicApp.updateOne({ _id: app._id }, { $inc: { docCount: -1 } });
      throw err;
    }
  },
);

export const listDocuments = asyncHandler(
  async (req: Request, res: Response) => {
    // ✅ FIX: kasih default "" biar TypeScript gak protes
    const { slug = "", name = "" } = req.params;
    const resolved = await resolveAppAndCollection(slug, name);
    if (!resolved)
      return fail(res, 404, "RUNTIME_NOT_FOUND", {}, "Collection not found");

    const { app, col } = resolved;
    if (col.policy !== "public-read") {
      return fail(
        res,
        403,
        "RUNTIME_FORBIDDEN",
        {},
        "This collection is private",
      );
    }

    // Pagination
    const limit = Math.min(
      50,
      Math.max(1, parseInt(req.query.limit as string) || 20),
    );
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const skip = (page - 1) * limit;

    // Filter HANYA boleh equality pada field terdaftar
    const filter: Record<string, any> = {
      appId: app._id,
      collectionId: col._id,
    };
    const allowedKeys = new Set(col.fields.map((f) => f.key));

    for (const [key, val] of Object.entries(req.query)) {
      if (key === "limit" || key === "page") continue;
      if (allowedKeys.has(key) && typeof val === "string") {
        // Validasi tipe filter
        const fieldDef = col.fields.find((f) => f.key === key);
        if (fieldDef?.type === "number") filter[`data.${key}`] = Number(val);
        else if (fieldDef?.type === "boolean")
          filter[`data.${key}`] = val === "true";
        else filter[`data.${key}`] = val;
      }
    }

    const docs = await DynamicDocument.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({
      data: docs.map((d) => ({ id: d._id, ...d.data, createdAt: d.createdAt })),
      page,
      limit,
    });
  },
);

export const getDocument = asyncHandler(async (req: Request, res: Response) => {
  const { slug = "", name = "", id = "" } = req.params;

  const resolved = await resolveAppAndCollection(slug, name);
  if (!resolved)
    return fail(res, 404, "RUNTIME_NOT_FOUND", {}, "Collection not found");

  const { app, col } = resolved;
  if (col.policy !== "public-read") {
    return fail(
      res,
      403,
      "RUNTIME_FORBIDDEN",
      {},
      "This collection is not public-read",
    );
  }

  if (!mongoose.isObjectIdOrHexString(id)) {
    return fail(res, 404, "RUNTIME_NOT_FOUND", {}, "Document not found");
  }

  const doc = await DynamicDocument.findOne({
    _id: id,
    appId: app._id,
    collectionId: col._id,
  }).lean();

  if (!doc)
    return fail(res, 404, "RUNTIME_NOT_FOUND", {}, "Document not found");

  res.json({
    data: { id: doc._id, ...doc.data, createdAt: doc.createdAt },
  });
});
