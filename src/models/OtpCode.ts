// src/models/OtpCode.ts

import mongoose, { Schema } from "mongoose";

export type OtpPurpose = "register";

export interface IOtpPayload {
  name: string;
  passwordHash: string;
  referralCode: string | null;
}

export interface IOtpCode {
  email: string;
  purpose: OtpPurpose;
  codeHash: string;
  payload: IOtpPayload;
  attempts: number;
  resendCount: number;
  lastSentAt: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PayloadSchema = new Schema<IOtpPayload>(
  {
    name: { type: String, required: true },
    passwordHash: { type: String, required: true },
    referralCode: { type: String, default: null },
  },
  { _id: false },
);

const OtpCodeSchema = new Schema<IOtpCode>(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    purpose: { type: String, enum: ["register"], required: true },
    codeHash: { type: String, required: true },
    payload: { type: PayloadSchema, required: true },
    attempts: { type: Number, default: 0, min: 0 },
    resendCount: { type: Number, default: 0, min: 0 },
    lastSentAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

OtpCodeSchema.index({ email: 1, purpose: 1 });
OtpCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OtpCode = mongoose.model<IOtpCode>("OtpCode", OtpCodeSchema);
