// src/services/credits.ts

import { Project } from "../models/Project.js";
import { User } from "../models/User.js";

const intEnv = (name: string, fallback: number): number => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const creditCosts = () => ({
  generate: intEnv("CREDIT_COST_GENERATE", 12),
  revision: intEnv("CREDIT_COST_REVISION", 3),
  exportCost: intEnv("CREDIT_COST_EXPORT", 30),
  exportCostRepeat: intEnv("CREDIT_COST_EXPORT_REPEAT", 10),
  // Phase 2: biaya & durasi subdomain jangan hardcode di controller.
  subdomain: {
    cost: intEnv("CREDIT_COST_SUBDOMAIN", 100),
    days: intEnv("SUBDOMAIN_DAYS", 30),
  },
});

export const exportCostFor = (
  firstExportAt: Date | null | undefined,
): number =>
  firstExportAt ? creditCosts().exportCostRepeat : creditCosts().exportCost;

export async function chargeCredits(userId: string, cost: number) {
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

export async function refundCredits(userId: string, amount: number) {
  if (!(amount > 0)) return true;
  try {
    await User.updateOne({ _id: userId }, { $inc: { credits: amount } });
    return true;
  } catch (err: any) {
    console.error(
      `[Credits] REFUND FAILED user=${String(userId)} amount=${amount}: ${err?.message ?? err}`,
    );
    return false;
  }
}

export async function refundHeld(projectId: string) {
  try {
    const claimed = await Project.findOneAndUpdate(
      { _id: projectId, creditsHeld: { $gt: 0 } },
      { $set: { creditsHeld: 0 } },
      { returnDocument: "before", projection: { owner: 1, creditsHeld: 1 } },
    );
    if (!claimed || !(claimed.creditsHeld > 0)) return 0;

    const ok = await refundCredits(
      claimed.owner.toString(),
      claimed.creditsHeld,
    );
    if (!ok) return 0;

    console.log(
      `[Credits] refunded ${claimed.creditsHeld} for project ${String(projectId)}`,
    );
    return claimed.creditsHeld;
  } catch (err: any) {
    console.error(
      `[Credits] REFUND FAILED project=${String(projectId)}: ${err?.message ?? err}`,
    );
    return 0;
  }
}

export async function getBalance(userId: string) {
  try {
    const user = await User.findById(userId).select("credits").lean();
    return user ? (user.credits ?? 0) : null;
  } catch {
    return null;
  }
}

export function rejectCharge(res: any, failure: any) {
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
