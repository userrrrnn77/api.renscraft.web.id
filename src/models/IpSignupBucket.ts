// src/models/IpSignupBucket.ts

import mongoose, { Schema } from "mongoose";

// How many accounts signed up (and asked for free credits) from one IP inside
// the current window. One small document per IP; MongoDB's TTL monitor deletes
// it once the window is over (it runs about once a minute, so the window can
// overrun by up to a minute).
export interface IIpSignupBucket {
  ipHash: string;
  count: number;
  expiresAt: Date;
}

const IpSignupBucketSchema = new Schema<IIpSignupBucket>({
  ipHash: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
});

IpSignupBucketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IpSignupBucket = mongoose.model<IIpSignupBucket>(
  "IpSignupBucket",
  IpSignupBucketSchema,
);
