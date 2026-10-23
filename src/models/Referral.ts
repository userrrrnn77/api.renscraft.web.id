// src/models/Referral.ts

import mongoose, { Schema, type Types } from "mongoose";

export interface IReferralRedemption {
  userId: Types.ObjectId;
  userIpHash: string | null;
  creditsNewUser: number;
  creditsOwner: number;
  at: Date;
}

export interface IReferral {
  code: string;
  owner: Types.ObjectId;
  ownerIpHash: string | null;
  redemptions: IReferralRedemption[];
  createdAt: Date;
  updatedAt: Date;
}

const RedemptionSchema = new Schema<IReferralRedemption>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    userIpHash: { type: String, default: null },
    creditsNewUser: { type: Number, required: true },
    creditsOwner: { type: Number, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ReferralSchema = new Schema<IReferral>(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      maxlength: 16,
    },
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    ownerIpHash: { type: String, default: null },
    redemptions: { type: [RedemptionSchema], default: [] },
  },
  { timestamps: true },
);

ReferralSchema.index({ "redemptions.userId": 1 });

export const Referral = mongoose.model<IReferral>("Referral", ReferralSchema);
