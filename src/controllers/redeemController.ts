// src/controllers/redeemController.ts
import { asyncHandler } from "../utils/asyncHandler.js";
import { fail } from "../utils/apiError.js";
import { redeemCodeForUser } from "../services/redeem.js";
import { getBalance } from "../services/credits.js";
import type { Request, Response } from "express";

interface AuthedRequest extends Request {
  user?: { userId?: string };
}

const userIdOf = (req: Request): string | null => {
  const id = (req as AuthedRequest).user?.userId;
  return typeof id === "string" && id ? id : null;
};

// Rate limit per user: 10 attempt / 15 menit
const attempts = new Map<string, { count: number; until: number }>();
const LIMIT = 10;
const WINDOW_MS = 15 * 60 * 1000;

const allow = (userId: string): boolean => {
  const now = Date.now();
  const e = attempts.get(userId);
  if (!e || e.until < now) return true;
  return e.count < LIMIT;
};
const record = (userId: string): void => {
  const now = Date.now();
  const e = attempts.get(userId);
  if (!e || e.until < now)
    attempts.set(userId, { count: 1, until: now + WINDOW_MS });
  else e.count += 1;
};

const ERRORS: Record<string, [number, string, string]> = {
  empty: [400, "REDEEM_CODE_REQUIRED", "Code is required"],
  invalid: [404, "REDEEM_INVALID", "Code not found"],
  expired: [410, "REDEEM_EXPIRED", "This code has expired"],
  exhausted: [410, "REDEEM_EXHAUSTED", "This code has reached its limit"],
  already_redeemed: [
    409,
    "REDEEM_ALREADY_USED",
    "You already redeemed this code",
  ],
  no_user: [
    401,
    "ACCOUNT_NOT_FOUND",
    "Account not found, please sign in again.",
  ],
};

export const redeem = asyncHandler(async (req: Request, res: Response) => {
  const userId = userIdOf(req);

  if (!userId) {
    return fail(res, 401, "AUTH_NOT_AUTHENTICATED", {}, "Not authenticated");
  }

  if (!allow(userId)) {
    return fail(
      res,
      429,
      "REDEEM_TOO_MANY_ATTEMPTS",
      {},
      "Too many attempts, try again in 15 minutes",
    );
  }

  const code = typeof req.body?.code === "string" ? req.body.code : "";
  const result = await redeemCodeForUser(userId, code);

  if (!result.ok) {
    record(userId);
    const [status, c, msg] = ERRORS[result.reason] ?? [
      400,
      "REDEEM_FAILED",
      "Could not redeem code",
    ];
    return fail(res, status, c, {}, msg);
  }

  attempts.delete(userId); // sukses = reset counter
  const balance = await getBalance(userId);
  res.json({ ok: true, credits: result.credits, balance });
});
