// src/models/DynamicDocument.ts
import mongoose, { Schema, type Types } from "mongoose";

export interface IDynamicDocument {
  appId: Types.ObjectId;
  collectionId: Types.ObjectId;
  data: Record<string, any>;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const DynamicDocumentSchema = new Schema<IDynamicDocument>(
  {
    appId: { type: Schema.Types.ObjectId, ref: "DynamicApp", required: true },
    collectionId: {
      type: Schema.Types.ObjectId,
      ref: "DynamicCollection",
      required: true,
    },
    data: { type: Schema.Types.Mixed, default: {} },
    schemaVersion: { type: Number, required: true },
  },
  { timestamps: true },
);

// Index buat paginasi dan filter
DynamicDocumentSchema.index({ appId: 1, collectionId: 1, createdAt: -1 });

export const DynamicDocument = mongoose.model<IDynamicDocument>(
  "DynamicDocument",
  DynamicDocumentSchema,
);
