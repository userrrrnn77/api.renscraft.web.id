// src/models/Brief.js

import mongoose, { Schema } from "mongoose";
import { CATEGORY_IDS } from "../services/brief/slotCatalog.js";
import { briefConfig } from "../services/brief/briefConfig.js";

const SlotDefSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    question: { type: String, required: true },
    kind: {
      type: String,
      required: true,
      enum: [
        "text",
        "longtext",
        "list",
        "choice",
        "phone",
        "email",
        "handle",
        "url",
      ],
    },
    group: { type: String, enum: ["fact", "style"], default: "fact" },
    placeholder: { type: String, default: "" },
    options: { type: [String], default: [] },
    origin: { type: String, enum: ["catalog", "ai", "user"], default: "ai" },
    mapsTo: { type: String, default: null },
  },
  { _id: false },
);

const RefConsentSchema = new Schema(
  {
    accepted: { type: Boolean, required: true },
    at: { type: Date, required: true },
    ipHash: { type: String, default: "" },
  },
  { _id: false },
);

const BriefSchema = new Schema(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    prompt: { type: String, required: true, maxlength: 4000 },
    category: { type: String, required: true, enum: [...CATEGORY_IDS] },
    confidence: { type: Number },
    slots: { type: [SlotDefSchema], default: [] },
    answers: { type: Schema.Types.Mixed, default: {} },
    questionKeys: { type: [String], default: [] },
    // "inspiration" = hanya design tokens; "remake" = teks + gambar + multi-page.
    // null = belum dipilih (wizard akan menampilkan langkah Referensi).
    refMode: {
      type: String,
      enum: ["inspiration", "remake", null],
      default: null,
    },
    // Consent hanya relevan untuk mode remake.
    refConsent: { type: RefConsentSchema, default: null },
    status: {
      type: String,
      enum: ["classifying", "open", "failed", "used"],
      default: "open",
    },
  },
  {
    timestamps: true,
    minimize: false,
  },
);

BriefSchema.index({ owner: 1, createdAt: -1 });
BriefSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: briefConfig().ttlHours * 3600 },
);

export const Brief = mongoose.model("Brief", BriefSchema);
