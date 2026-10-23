// src/services/redeem.ts
import { CreditTransaction } from "../models/CreditTransaction.js";
import { RedeemCode } from "../models/RedeemCode.js";
import { User } from "../models/User.js";

export type RedeemResult =
  | { ok: true; credits: number; balance: number | null }
  | {
      ok: false;
      reason:
        | "invalid"
        | "expired"
        | "exhausted"
        | "already_redeemed"
        | "no_user"
        | "empty";
    };

const isDup = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  (err as { code?: unknown }).code === 11000;

export async function redeemCodeForUser(
  userId: string,
  rawCode: string,
): Promise<RedeemResult> {
  const code = String(rawCode ?? "")
    .trim()
    .toUpperCase();
  if (!code) return { ok: false, reason: "empty" };

  const now = new Date();
  const codeDoc = await RedeemCode.findOne({ code }).lean();
  if (!codeDoc) return { ok: false, reason: "invalid" };
  if (codeDoc.expiresAt.getTime() <= now.getTime())
    return { ok: false, reason: "expired" };
  if (codeDoc.redemptionCount >= codeDoc.maxRedemptions)
    return { ok: false, reason: "exhausted" };

  // 1. Atomic claim: hanya menang kalau masih ada slot & belum expired
  const claimed = await RedeemCode.findOneAndUpdate(
    {
      _id: codeDoc._id,
      expiresAt: { $gt: now },
      $expr: { $lt: ["$redemptionCount", "$maxRedemptions"] },
    },
    { $inc: { redemptionCount: 1 } },
    { returnDocument: "after" },
  );
  if (!claimed) {
    const fresh = await RedeemCode.findById(codeDoc._id).lean();
    if (!fresh) return { ok: false, reason: "invalid" };
    if (fresh.expiresAt.getTime() <= now.getTime())
      return { ok: false, reason: "expired" };
    return { ok: false, reason: "exhausted" };
  }

  // 2. Ledger entry pakai key unik → cegah user yang sama redeem 2x
  const key = `redeem:${claimed._id}:${userId}`;
  try {
    await CreditTransaction.create({
      user: userId,
      type: "redeem",
      amount: claimed.credits,
      balanceAfter: 0, // diisi setelah user di-credit
      refKind: "redeem_code",
      refId: String(claimed._id),
      key,
    });
  } catch (err) {
    // rollback slot
    await RedeemCode.updateOne(
      { _id: claimed._id },
      { $inc: { redemptionCount: -1 } },
    );
    if (isDup(err)) return { ok: false, reason: "already_redeemed" };
    throw err;
  }

  // 3. Credit user
  const user = await User.findOneAndUpdate(
    { _id: userId },
    { $inc: { credits: claimed.credits } },
    { returnDocument: "after", projection: { credits: 1 } },
  );
  if (!user) {
    await CreditTransaction.deleteOne({ key });
    await RedeemCode.updateOne(
      { _id: claimed._id },
      { $inc: { redemptionCount: -1 } },
    );
    return { ok: false, reason: "no_user" };
  }

  await CreditTransaction.updateOne(
    { key },
    { $set: { balanceAfter: user.credits } },
  );

  console.log(
    `[Redeem] user=${userId} code=${code} +${claimed.credits} credits`,
  );
  return { ok: true, credits: claimed.credits, balance: user.credits };
}
