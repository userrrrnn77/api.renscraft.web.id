// src/services/referral.ts
//
// One Referral doc per user (owner), holding an array of redemptions.
// Codes are created lazily: either right after a successful registration, or
// the first time the user opens their profile page.
//
// Anti-farming:
//   - self-referral blocked (owner IP == new-user IP → no reward)
//   - one user can only ever redeem one referral (atomic $ne check)
//   - code expires after REFERRAL_TTL_DAYS

import crypto from "node:crypto";
import mongoose from "mongoose";
import { Referral } from "../models/Referral.js";

const CODE_PREFIX = "RNS-";
const CODE_LENGTH = 6;
// No 0/1/O/I: codes get read aloud and typed by hand.
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const rewardNewUser = () =>
  Math.max(0, Number(process.env.REFERRAL_REWARD_NEW_USER) || 10);
export const rewardOwner = () =>
  Math.max(0, Number(process.env.REFERRAL_REWARD_OWNER) || 15);
export const referralTtlDays = () =>
  Math.max(1, Number(process.env.REFERRAL_TTL_DAYS) || 90);

export const REFERRAL_CODE_RE = /^RNS-[A-HJ-NP-Z2-9]{6}$/;

// Returns the normalized code, or null if the input is not a valid shape.
// Never throws: a malformed `?referral=` is treated exactly like no referral.
export function normalizeReferralCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return REFERRAL_CODE_RE.test(code) ? code : null;
}

function randomCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_CHARS[bytes[i]! % CODE_CHARS.length];
  }
  return CODE_PREFIX + out;
}

// ── Create / fetch the user's own code ──────────────────────────────────────

export interface EnsureReferralResult {
  code: string;
  created: boolean;
}

export async function ensureReferralForUser(
  userId: string | mongoose.Types.ObjectId,
  ownerIpHash: string | null,
): Promise<EnsureReferralResult> {
  const existing = await Referral.findOne({ owner: userId }).lean();
  if (existing) return { code: existing.code, created: false };

  // Retry on the (very unlikely) unique collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    try {
      const doc = await Referral.create({
        code,
        owner: userId,
        ownerIpHash,
        redemptions: [],
      });
      return { code: doc.code, created: true };
    } catch (err) {
      const isDup =
        typeof err === "object" &&
        err !== null &&
        (err as { code?: unknown }).code === 11000;
      if (!isDup) throw err;

      // Two writers can race here; the owner-unique index catches it.
      const raced = await Referral.findOne({ owner: userId }).lean();
      if (raced) return { code: raced.code, created: false };
      // otherwise it was a code collision: loop and try a new code
    }
  }
  throw new Error("Could not generate a referral code");
}

// ── Lookup for redemption ───────────────────────────────────────────────────

export type ReferralRejectReason = "not_found" | "expired" | "self";

export interface ReferralLookup {
  referral: Awaited<ReturnType<typeof Referral.findOne>> | null;
  reason?: ReferralRejectReason;
}

// ── Atomic redemption ───────────────────────────────────────────────────────

// Pushes the redemption and returns the updated doc, or null if the user has
// already redeemed (any code) — the $ne filter is the idempotency guard.
// The caller is responsible for actually moving credits.
export async function claimRedemption(
  referralId: mongoose.Types.ObjectId,
  userId: mongoose.Types.ObjectId,
  userIpHash: string | null,
  creditsNewUser: number,
  creditsOwner: number,
) {
  return Referral.findOneAndUpdate(
    { _id: referralId, "redemptions.userId": { $ne: userId } },
    {
      $push: {
        redemptions: {
          userId,
          userIpHash,
          creditsNewUser,
          creditsOwner,
          at: new Date(),
        },
      },
    },
    { returnDocument: "after" },
  );
}

// Tambahkan di bagian paling bawah file referral.ts

import { User } from "../models/User.js";
import { CreditTransaction } from "../models/CreditTransaction.js";

// Bypass IP check di localhost biar gampang testing
const isLocalIp = (ip: string | null) => {
  if (!ip) return false;
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip.startsWith("192.168.") // optional: IP WiFi lokal lu
  );
};

// Fungsi pembantu buat ngasih kredit (dipake di OTP & OAuth)

export async function lookupReferral(
  code: string,
  signupIpHash: string | null,
): Promise<ReferralLookup> {
  const referral = await Referral.findOne({ code });
  if (!referral) return { referral: null, reason: "not_found" };

  const ageDays =
    (Date.now() - new Date(referral.createdAt).getTime()) / 86_400_000;
  if (ageDays > referralTtlDays()) {
    return { referral: null, reason: "expired" };
  }

  // Strict check: kalau IP sama, reject!
  if (
    signupIpHash &&
    referral.ownerIpHash &&
    signupIpHash === referral.ownerIpHash
  ) {
    return { referral: null, reason: "self" };
  }

  return { referral };
}

// Sesuaikan juga parameter processReferralRewards (buang signupRawIp)
export async function processReferralRewards(
  userId: mongoose.Types.ObjectId,
  referralCode: string | null,
  signupIpHash: string | null,
  userCreditsAfterCreate: number,
) {
  if (!referralCode) return { applied: false, credits: 0 };

  const lookup = await lookupReferral(referralCode, signupIpHash);
  if (!lookup.referral) {
    console.log(`[Referral] rejected (${lookup.reason}) for user=${userId}`);
    return { applied: false, credits: 0 };
  }

  const claimed = await claimRedemption(
    lookup.referral._id,
    userId,
    signupIpHash,
    rewardNewUser(),
    rewardOwner(),
  );

  if (!claimed) return { applied: false, credits: 0 };

  const newUser = await User.findByIdAndUpdate(
    userId,
    { $inc: { credits: rewardNewUser() } },
    { returnDocument: "after", projection: { credits: 1 } },
  );

  const owner = await User.findByIdAndUpdate(
    lookup.referral.owner,
    { $inc: { credits: rewardOwner() } },
    { returnDocument: "after", projection: { credits: 1 } },
  );

  if (!owner) {
    console.warn(`[Referral] Owner ${lookup.referral.owner} not found`);
  }

  await CreditTransaction.create({
    user: userId,
    type: "signup_grant",
    amount: rewardNewUser(),
    balanceAfter: newUser?.credits ?? userCreditsAfterCreate + rewardNewUser(),
    refKind: "referral",
    refId: String(lookup.referral._id),
    key: `referral_new:${lookup.referral._id}:${userId}`,
  }).catch((e) => console.warn("[Referral] ledger new failed:", e.message));

  if (owner) {
    await CreditTransaction.create({
      user: lookup.referral.owner,
      type: "admin_grant",
      amount: rewardOwner(),
      balanceAfter: owner.credits,
      refKind: "referral",
      refId: String(lookup.referral._id),
      key: `referral_owner:${lookup.referral._id}:${userId}`,
    }).catch((e) => console.warn("[Referral] ledger owner failed:", e.message));
  }

  return { applied: true, credits: rewardNewUser() };
}
