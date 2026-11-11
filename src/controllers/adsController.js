// server/src/controllers/adsController.js
import { asyncHandler } from "../utils/asyncHandler.js";
import { fail } from "../utils/apiError.js";
import { createAdSession, claimAdReward } from "../services/ads.js";
import { getClientIp } from "../services/abuseGuard.js";

export const startAd = asyncHandler(async (req, res) => {
  const ip = getClientIp(req);
  const result = await createAdSession(req.user.userId, ip);

  if (!result.ok) {
    return fail(res, 429, result.error, {}, result.message);
  }

  res.status(201).json(result);
});

export const claimAd = asyncHandler(async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId)
    return fail(res, 400, "BAD_REQUEST", {}, "Session ID is required");

  const result = await claimAdReward(req.user.userId, sessionId);

  if (!result.ok) {
    return fail(res, 400, result.error, {}, result.message);
  }

  res.json(result);
});
