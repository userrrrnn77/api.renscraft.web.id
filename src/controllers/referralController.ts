// src/controllers/referralController.ts
import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { Referral } from "../models/Referral.js";
import { getClientIp, hashIp } from "../services/abuseGuard.js";
import {
  ensureReferralForUser,
  referralTtlDays,
} from "../services/referral.js";

interface AuthedRequest extends Request {
  user?: { userId?: string };
}

const userIdOf = (req: Request): string | null => {
  const id = (req as AuthedRequest).user?.userId;
  return typeof id === "string" && id ? id : null;
};

// GET /api/referral/me
// Lazily creates the code on first access so accounts that registered before
// this feature existed still get one.
export const getMyReferral = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = userIdOf(req);
    if (!userId) {
      res
        .status(401)
        .json({ error: "Not authenticated", code: "AUTH_NOT_AUTHENTICATED" });
      return;
    }

    const ip = getClientIp(req);
    const ipHash = ip ? hashIp(ip) : null;

    const { code } = await ensureReferralForUser(userId, ipHash);
    const doc = await Referral.findOne({ owner: userId }).lean();

    const redemptions = doc?.redemptions ?? [];
    const totalEarned = redemptions.reduce(
      (sum, r) => sum + (r.creditsOwner || 0),
      0,
    );

    res.json({
      code,
      createdAt: doc?.createdAt ?? null,
      expiresAt: doc
        ? new Date(
            new Date(doc.createdAt).getTime() + referralTtlDays() * 86_400_000,
          )
        : null,
      redemptionCount: redemptions.length,
      totalEarned,
      recentRedemptions: redemptions
        .slice(-5)
        .reverse()
        .map((r) => ({ at: r.at, credits: r.creditsOwner })),
    });
  },
);
