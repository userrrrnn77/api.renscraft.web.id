// src/models/Project.js

import mongoose, { Schema } from "mongoose";

export const BUSY_STATUSES = ["pending", "generating", "revising"];
export const PROJECT_STATUSES = [...BUSY_STATUSES, "completed", "failed"];

export const PROJECT_ERROR_CODES = [
  "GENERATION_FAILED",
  "GENERATION_TIMEOUT",
  "REVISION_TIMEOUT",
  "REVISION_NO_CHANGE",
  "REVISION_ABORTED",
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

const QualityIssueSchema = new Schema(
  {
    code: String,
    severity: { type: String, enum: ["blocking", "warning"] },
    stage: String,
    path: String,
    message: String,
    autoFixed: Boolean,
  },
  { _id: false },
);

const QualityReportSchema = new Schema(
  {
    status: {
      type: String,
      enum: ["pending", "passed", "passed_with_warnings", "failed"],
      default: "pending",
    },
    issues: { type: [QualityIssueSchema], default: [] },
    stages: { type: Schema.Types.Mixed, default: {} },
    repairRounds: { type: Number, default: 0 },
    checkedAt: Date,
    version: Number,
  },
  { _id: false },
);

const RemakeConsentSchema = new Schema(
  {
    at: { type: Date, required: true },
    ipHash: { type: String, default: "" },
    urls: { type: [String], default: [] },
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

    // ─── FITUR PREMIUM SUBDOMAIN ───
    customSubdomain: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      lowercase: true,
    },
    subdomainExpiresAt: {
      type: Date,
      default: null,
    },

    // ─── FITUR REMAKE DARI URL ───
    // Array hostname (lowercase tanpa "www") yang di-remake. Unik, maks 5.
    // Dikosongkan kalau project bukan remake.
    remakeOf: { type: [String], default: [] },
    // Bukti consent untuk mode remake. JANGAN pernah dikirim ke publik.
    remakeConsent: { type: RemakeConsentSchema, default: null },

    status: {
      type: String,
      enum: PROJECT_STATUSES,
      default: "pending",
    },
    filesPlanned: { type: [PlannedFileSchema], default: [] },
    filesGenerated: { type: [String], default: [] },
    currentFile: { type: String, default: null },
    error: { type: String, default: null },
    errorCode: { type: String, default: null },
    creditsHeld: { type: Number, default: 0, min: 0 },
    firstExportAt: { type: Date, default: null },
    brief: { type: Schema.Types.Mixed, default: null },
    dataSpec: { type: Schema.Types.Mixed, default: null },
    quality: { type: QualityReportSchema, default: null },
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
ProjectSchema.index({ remakeOf: 1 });

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
