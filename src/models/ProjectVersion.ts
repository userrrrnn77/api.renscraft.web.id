// src/models/ProjectVersion.ts
//
// F6: snapshot versi project. Disimpan di collection terpisah supaya dokumen
// Project (dengan files besar) tidak mendekati limit 16 MB MongoDB.
import mongoose, { Schema } from "mongoose";

const ProjectVersionSchema = new Schema(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true,
    },
    version: { type: Number, required: true, min: 1 },
    files: { type: Schema.Types.Mixed, default: {} },
    prompt: { type: String, default: null, maxlength: 4000 },
    quality: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ProjectVersionSchema.index({ projectId: 1, version: -1 });
ProjectVersionSchema.index({ projectId: 1, version: 1 }, { unique: true });

export const ProjectVersion = mongoose.model(
  "ProjectVersion",
  ProjectVersionSchema,
);
