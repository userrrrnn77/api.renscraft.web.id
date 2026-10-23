// src/models/Brief.js

import mongoose, { Schema } from "mongoose";
import { CATEGORY_IDS } from "../services/brief/slotCatalog.js";
import { briefConfig } from "../services/brief/briefConfig.js";

// Slot yang di-generate AI composer untuk brief ini. Bentuknya sama dengan
// slot catalog static (SLOTS), jadi semua modul hilir (validasi, rendering,
// placeholder) bisa memperlakukan keduanya dengan cara yang sama.
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
    // "catalog" = pakai key standar dari SLOTS (placeholder & validasi katalog
    // berlaku). "ai" = key x_* yang dibuat composer.
    origin: { type: String, enum: ["catalog", "ai", "user"], default: "ai" },
    // Optional: memetakan ke Project.contract.facts key, mis. "openingHours".
    // Dipakai mergeBriefFacts supaya facts tetap terisi walau key custom.
    mapsTo: { type: String, default: null },
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
    // Slot yang dirancang composer untuk brief ini (kategori + slot fakta
    // yang relevan). Menggantikan `extra` lama; untuk brief yang dibuat
    // sebelum migration, `slots` kosong dan slotDefsOf() fallback ke katalog.
    slots: { type: [SlotDefSchema], default: [] },
    answers: { type: Schema.Types.Mixed, default: {} },
    questionKeys: { type: [String], default: [] },
    status: {
      type: String,
      enum: ["classifying", "open", "used"],
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
