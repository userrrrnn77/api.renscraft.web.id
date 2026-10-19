// src/models/Project.js

import mongoose, { Schema } from "mongoose";

export const BUSY_STATUSES = ["pending", "generating", "revising"];
export const PROJECT_STATUSES = [...BUSY_STATUSES, "completed", "failed"];

// Kode error yang bisa muncul di Project.errorCode. Client translate lewat
// i18n key `projectErrors.<code>`. Sengaja dipisah dari `error` (teks bebas)
// karena `error` disimpan sebagai history buat debug, sedangkan `errorCode`
// yang ditampilkan ke user.
export const PROJECT_ERROR_CODES = [
  "GENERATION_FAILED",
  "GENERATION_TIMEOUT",
  "REVISION_TIMEOUT",
  "REVISION_NO_CHANGE",
  "NO_APP_JS",
];

const MessageSchema = new Schema(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false },
);

const PlannedFileSchema = new Schema(
  {
    path: { type: String, required: true },
    description: { type: String, required: true },
  },
  { _id: false },
);

const ProjectSchema = new Schema(
  {
    name: { type: String, required: true, default: "Untitled Project" },
    description: { type: String, default: "" },
    files: { type: Schema.Types.Mixed, default: {} },
    messages: { type: [MessageSchema], default: [] },
    version: { type: Number, default: 0 },
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    published: { type: Boolean, default: false },
    status: {
      type: String,
      enum: PROJECT_STATUSES,
      default: "pending",
    },
    filesPlanned: { type: [PlannedFileSchema], default: [] },
    filesGenerated: { type: [String], default: [] },
    currentFile: { type: String, default: null },
    // Teks bebas buat debug/log. Jangan dipakai client buat ditampilkan —
    // pakai errorCode.
    error: { type: String, default: null },
    // Kode yang ditampilkan ke user (di-translate di client). Lihat
    // PROJECT_ERROR_CODES di atas.
    errorCode: { type: String, default: null },
    creditsHeld: { type: Number, default: 0, min: 0 },
    brief: { type: Schema.Types.Mixed, default: null },
    uploadedImages: {
      type: [
        {
          _id: false,
          url: { type: String, required: true },
          name: { type: String, default: "" },
          addedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
  },
);

ProjectSchema.index({ owner: 1, updatedAt: -1 });

ProjectSchema.index(
  { name: 1 },
  {
    unique: true,
    partialFilterExpression: { published: true },
    collation: { locale: "en", strength: 2 },
  },
);

ProjectSchema.statics.acquireLock = function (
  id,
  owner,
  status = "revising",
  extra = {},
) {
  return this.findOneAndUpdate(
    { _id: id, owner, status: { $nin: BUSY_STATUSES } },
    { $set: { ...extra, status, error: null, errorCode: null } },
    { returnDocument: "after" },
  );
};

export const Project = mongoose.model("Project", ProjectSchema);