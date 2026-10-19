// src/services/credits.ts
//
// (header comment sama seperti aslinya, gua skip biar fokus)

import type { Response } from "express";
import type { Types } from "mongoose";
import { Project } from "../models/Project.js";
import { User } from "../models/User.js";

const intEnv = (name: string, fallback: number): number => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const creditCosts = () => ({
  generate: intEnv("CREDIT_COST_GENERATE", 12),
  revision: intEnv("CREDIT_COST_REVISION", 3),
});

type UserId = string | Types.ObjectId;

export type ChargeResult =
  | { ok: true; balance: number }
  | { ok: false; reason: "insufficient"; balance: number; required: number }
  | { ok: false; reason: "no_user" };

export type ChargeFailure = Extract<ChargeResult, { ok: false }>;

export async function chargeCredits(
  userId: UserId,
  cost: number,
): Promise<ChargeResult> {
  const updated = await User.findOneAndUpdate(
    { _id: userId, credits: { $gte: cost } },
    { $inc: { credits: -cost } },
    { returnDocument: "after", projection: { credits: 1 } },
  );
  if (updated) return { ok: true, balance: updated.credits };

  const current = await User.findById(userId).select("credits").lean();
  if (!current) return { ok: false, reason: "no_user" };
  return {
    ok: false,
    reason: "insufficient",
    balance: current.credits ?? 0,
    required: cost,
  };
}

export async function refundCredits(
  userId: UserId,
  amount: number,
): Promise<boolean> {
  if (!(amount > 0)) return true;
  try {
    await User.updateOne({ _id: userId }, { $inc: { credits: amount } });
    return true;
  } catch (err) {
    console.error(
      `[Credits] REFUND FAILED user=${String(userId)} amount=${amount}: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

export async function refundHeld(
  projectId: string | Types.ObjectId,
): Promise<number> {
  try {
    const claimed = await Project.findOneAndUpdate(
      { _id: projectId, creditsHeld: { $gt: 0 } },
      { $set: { creditsHeld: 0 } },
      { returnDocument: "before", projection: { owner: 1, creditsHeld: 1 } },
    );
    if (!claimed || !(claimed.creditsHeld > 0)) return 0;

    const ok = await refundCredits(claimed.owner, claimed.creditsHeld);
    if (!ok) return 0;
    console.log(
      `[Credits] refunded ${claimed.creditsHeld} for project ${String(projectId)}`,
    );
    return claimed.creditsHeld;
  } catch (err) {
    console.error(
      `[Credits] REFUND FAILED project=${String(projectId)}: ${err instanceof Error ? err.message : err}`,
    );
    return 0;
  }
}

export async function getBalance(userId: UserId): Promise<number | null> {
  try {
    const user = await User.findById(userId).select("credits").lean();
    return user ? (user.credits ?? 0) : null;
  } catch {
    return null;
  }
}

// Satu-satunya tempat yang jawab charge gagal. Params pakai `credits` (bukan
// `have`) biar file lama tetap kompatibel, dan klien baru bisa translate.
export function rejectCharge(res: Response, failure: ChargeFailure): void {
  if (failure.reason === "no_user") {
    res.status(401).json({
      error: "Account not found, please sign in again.",
      code: "ACCOUNT_NOT_FOUND",
    });
    return;
  }
  res.status(402).json({
    error: `Not enough credits: this needs ${failure.required}, you have ${failure.balance}.`,
    code: "INSUFFICIENT_CREDITS",
    params: {
      required: failure.required,
      credits: failure.balance,
    },
  });
}
