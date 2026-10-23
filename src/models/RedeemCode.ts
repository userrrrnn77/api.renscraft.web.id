// src/models/RedeemCode.ts
import mongoose, { Schema, type Types } from "mongoose";

export interface IRedeemCode {
  code: string;
  credits: number;
  maxRedemptions: number;
  redemptionCount: number;
  expiresAt: Date;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const int = { validator: Number.isInteger, message: "must be an integer" };

const RedeemCodeSchema = new Schema<IRedeemCode>(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      maxlength: 64,
    },
    credits: { type: Number, required: true, min: 1, validate: int },
    maxRedemptions: { type: Number, required: true, min: 1, validate: int },
    redemptionCount: { type: Number, default: 0, min: 0, validate: int },
    expiresAt: { type: Date, required: true },
    createdBy: { type: String, default: "admin", maxlength: 60 },
  },
  { timestamps: true },
);

RedeemCodeSchema.index({ expiresAt: 1 });

export const RedeemCode = mongoose.model<IRedeemCode>(
  "RedeemCode",
  RedeemCodeSchema,
);
