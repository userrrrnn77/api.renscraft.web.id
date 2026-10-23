// src/services/otp.ts
//
// Generates, sends, verifies and consumes register OTPs. Every OTP row lives in
// OtpCode and dies on its own (TTL index on expiresAt). Passwords are bcrypt-
// hashed BEFORE they hit the OTP row, so a leak of the OTP collection never
// leaks a plaintext password.

import crypto from "node:crypto";
import { OtpCode } from "../models/OtpCode.js";
import { isEmailConfigured, sendOtpEmail } from "./email.js";

const OTP_LENGTH = () =>
  Math.max(4, Math.min(8, Number(process.env.OTP_LENGTH) || 6));
const OTP_TTL_MINUTES = () =>
  Math.max(1, Math.min(60, Number(process.env.OTP_TTL_MINUTES) || 10));
const OTP_MAX_ATTEMPTS = () =>
  Math.max(1, Number(process.env.OTP_MAX_ATTEMPTS) || 5);
const OTP_RESEND_COOLDOWN_SECONDS = () =>
  Math.max(0, Number(process.env.OTP_RESEND_COOLDOWN_SECONDS) || 60);
const OTP_MAX_RESEND = () =>
  Math.max(0, Number(process.env.OTP_MAX_RESEND) || 3);

export function generateOtp(): string {
  const len = OTP_LENGTH();
  const max = 10 ** len;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(len, "0");
}

export function hashOtp(code: string): string {
  const secret = process.env.JWT_SECRET || "dev-only-otp-secret";
  return crypto.createHmac("sha256", secret).update(code).digest("hex");
}

// ── Create ──────────────────────────────────────────────────────────────────

export interface CreateOtpArgs {
  email: string;
  payload: {
    name: string;
    passwordHash: string;
    referralCode: string | null;
  };
}

export interface CreateOtpResult {
  otpId: string;
  email: string;
  expiresAt: Date;
  resendAvailableAt: Date;
}

export async function createRegisterOtp(
  args: CreateOtpArgs,
): Promise<CreateOtpResult> {
  if (!isEmailConfigured() && process.env.NODE_ENV === "production") {
    throw new Error("Email is not configured");
  }

  // A new request invalidates every previous OTP for that email.
  await OtpCode.deleteMany({ email: args.email, purpose: "register" });

  const code = generateOtp();
  const ttlMinutes = OTP_TTL_MINUTES();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);

  const doc = await OtpCode.create({
    email: args.email,
    purpose: "register",
    codeHash: hashOtp(code),
    payload: args.payload,
    attempts: 0,
    resendCount: 0,
    lastSentAt: now,
    expiresAt,
  });

  // Send after DB write so a failed SMTP call does not orphan the OTP row.
  try {
    await sendOtpEmail({ to: args.email, code, ttlMinutes });
  } catch (err) {
    await OtpCode.deleteOne({ _id: doc._id }).catch(() => {});
    throw err;
  }

  return {
    otpId: doc._id.toString(),
    email: args.email,
    expiresAt,
    resendAvailableAt: new Date(
      now.getTime() + OTP_RESEND_COOLDOWN_SECONDS() * 1000,
    ),
  };
}

// ── Resend ──────────────────────────────────────────────────────────────────

export interface ResendOtpResult {
  otpId: string;
  expiresAt: Date;
  resendAvailableAt: Date;
}

// null = cannot resend (not found, expired, cooldown, or quota hit).
export async function resendRegisterOtp(
  otpId: string,
): Promise<ResendOtpResult | null> {
  const doc = await OtpCode.findById(otpId);
  if (!doc || doc.purpose !== "register") return null;

  const now = Date.now();
  if (doc.expiresAt.getTime() <= now) return null;
  if (doc.resendCount >= OTP_MAX_RESEND()) return null;

  const cooldownMs = OTP_RESEND_COOLDOWN_SECONDS() * 1000;
  if (now - doc.lastSentAt.getTime() < cooldownMs) return null;

  const code = generateOtp();
  const ttlMinutes = OTP_TTL_MINUTES();
  const expiresAt = new Date(now + ttlMinutes * 60_000);

  doc.codeHash = hashOtp(code);
  doc.attempts = 0;
  doc.resendCount += 1;
  doc.lastSentAt = new Date(now);
  doc.expiresAt = expiresAt;
  await doc.save();

  try {
    await sendOtpEmail({ to: doc.email, code, ttlMinutes });
  } catch (err) {
    // Roll the counter back so the next retry still has budget.
    doc.resendCount -= 1;
    await doc.save().catch(() => {});
    throw err;
  }

  return {
    otpId: doc._id.toString(),
    expiresAt,
    resendAvailableAt: new Date(now + cooldownMs),
  };
}

// ── Verify ──────────────────────────────────────────────────────────────────

export type VerifyOtpFailure =
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "too_many_attempts" }
  | { ok: false; reason: "wrong_code" };

export type VerifyOtpSuccess = {
  ok: true;
  otpId: string;
  email: string;
  payload: {
    name: string;
    passwordHash: string;
    referralCode: string | null;
  };
};

export async function verifyRegisterOtp(
  otpId: string,
  code: string,
): Promise<VerifyOtpSuccess | VerifyOtpFailure> {
  const doc = await OtpCode.findById(otpId);
  if (!doc || doc.purpose !== "register")
    return { ok: false, reason: "not_found" };
  if (doc.expiresAt.getTime() <= Date.now())
    return { ok: false, reason: "expired" };
  if (doc.attempts >= OTP_MAX_ATTEMPTS())
    return { ok: false, reason: "too_many_attempts" };

  const expected = Buffer.from(hashOtp(code), "hex");
  const stored = Buffer.from(doc.codeHash, "hex");
  const match =
    expected.length === stored.length &&
    crypto.timingSafeEqual(expected, stored);

  if (!match) {
    doc.attempts += 1;
    await doc.save();
    return { ok: false, reason: "wrong_code" };
  }

  return {
    ok: true,
    otpId: doc._id.toString(),
    email: doc.email,
    payload: {
      name: doc.payload.name,
      passwordHash: doc.payload.passwordHash,
      referralCode: doc.payload.referralCode ?? null,
    },
  };
}

export async function consumeOtp(otpId: string): Promise<void> {
  await OtpCode.deleteOne({ _id: otpId }).catch(() => {});
}
