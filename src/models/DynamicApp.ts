// src/models/DynamicApp.ts
import mongoose, { Schema, type Types } from "mongoose";

export interface IDynamicApp {
  ownerId: Types.ObjectId;
  sourceProjectId: Types.ObjectId;
  slug: string;
  status: "draft" | "published" | "suspended" | "archived";
  publishedVersion: number;
  publishedFiles: Record<string, any>;
  publishedAt?: Date;
  docCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const DynamicAppSchema = new Schema<IDynamicApp>(
  {
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sourceProjectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
    },
    slug: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ["draft", "published", "suspended", "archived"],
      default: "draft",
    },
    publishedVersion: { type: Number, default: 0 },
    publishedFiles: { type: Schema.Types.Mixed, default: {} },
    publishedAt: { type: Date },
    docCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const DynamicApp = mongoose.model<IDynamicApp>(
  "DynamicApp",
  DynamicAppSchema,
);
