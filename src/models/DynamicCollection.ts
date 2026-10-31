// src/models/DynamicCollection.ts
import mongoose, { Schema, type Types } from "mongoose";
import { ALLOWED_FIELD_TYPES } from "../utils/dynamicValidators.js";

export interface IDynamicField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  min?: number;
  max?: number;
  options?: string[];
}

export interface IDynamicCollection {
  appId: Types.ObjectId;
  name: string;
  label: string;
  fields: IDynamicField[];
  policy: "private" | "public-read" | "public-create-only";
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const DynamicFieldSchema = new Schema<IDynamicField>(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    type: { type: String, enum: ALLOWED_FIELD_TYPES, required: true },
    required: { type: Boolean, default: false },
    min: { type: Number },
    max: { type: Number },
    options: { type: [String], default: [] },
  },
  { _id: false },
);

const DynamicCollectionSchema = new Schema<IDynamicCollection>(
  {
    appId: { type: Schema.Types.ObjectId, ref: "DynamicApp", required: true },
    name: { type: String, required: true },
    label: { type: String, required: true },
    fields: { type: [DynamicFieldSchema], default: [] },
    policy: {
      type: String,
      enum: ["private", "public-read", "public-create-only"],
      default: "private",
    },
    schemaVersion: { type: Number, default: 1 },
  },
  { timestamps: true },
);

DynamicCollectionSchema.index({ appId: 1, name: 1 }, { unique: true });

export const DynamicCollection = mongoose.model<IDynamicCollection>(
  "DynamicCollection",
  DynamicCollectionSchema,
);
