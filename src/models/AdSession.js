// server/src/models/AdSession.js
import mongoose, { Schema } from "mongoose";

const AdSessionSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["pending", "credited", "expired"],
      default: "pending",
    },
    credits: { type: Number, required: true },
    ipHash: { type: String }, // buat ngetrack kalau ada abuse
  },
  { timestamps: true },
);

// Hapus otomatis session pending yang umurnya lebih dari 15 menit (biar DB gak bengkak)
AdSessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 15 * 60 });

export const AdSession = mongoose.model("AdSession", AdSessionSchema);
