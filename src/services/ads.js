// server/src/services/ads.js
import { AdSession } from "../models/AdSession.js";
import { User } from "../models/User.js";
import { CreditTransaction } from "../models/CreditTransaction.js";
import { hashIp } from "./abuseGuard.js";

// Konfigurasi (bisa dipindah ke env nanti)
const REWARD_CREDITS = parseInt(process.env.AD_REWARD_CREDITS || "15", 10);
const WATCH_DURATION_SECONDS = parseInt(
  process.env.AD_WATCH_SECONDS || "30",
  10,
);
const DAILY_LIMIT = parseInt(process.env.AD_DAILY_LIMIT || "3", 10);

export async function createAdSession(userId, reqIp) {
  // 1. Cek Limit Harian (Maksimal 3 kali sehari)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const todayClaims = await AdSession.countDocuments({
    userId,
    status: "credited",
    createdAt: { $gte: oneDayAgo },
  });

  if (todayClaims >= DAILY_LIMIT) {
    return {
      ok: false,
      error: "DAILY_LIMIT_REACHED",
      message: "Batas harian nonton iklan tercapai. Coba lagi besok.",
    };
  }

  // 2. Bikin Session baru
  const ipHash = reqIp ? hashIp(reqIp) : null;
  const session = await AdSession.create({
    userId,
    credits: REWARD_CREDITS,
    ipHash,
  });

  return {
    ok: true,
    sessionId: session._id,
    credits: REWARD_CREDITS,
    duration: WATCH_DURATION_SECONDS,
  };
}

export async function claimAdReward(userId, sessionId) {
  // 1. Cari session berdasarkan ID dan pastikan milik user yang login
  const session = await AdSession.findOne({
    _id: sessionId,
    userId,
    status: "pending",
  });

  if (!session) {
    return {
      ok: false,
      error: "INVALID_SESSION",
      message: "Sesi iklan tidak valid atau sudah diklaim.",
    };
  }

  // 2. CEK DURASI (Anti-Cheat Utama)
  const elapsedSeconds = (Date.now() - session.createdAt.getTime()) / 1000;
  if (elapsedSeconds < WATCH_DURATION_SECONDS) {
    // User nge-cheat dengan nembak API langsung
    await AdSession.updateOne(
      { _id: session._id },
      { $set: { status: "expired" } },
    );
    return {
      ok: false,
      error: "TOO_FAST",
      message: "Terlalu cepat. Selesaikan iklan terlebih dahulu.",
    };
  }

  // 3. Klaim (pakai findOneAndUpdate biar atomic, anti double-claim)
  const claimed = await AdSession.findOneAndUpdate(
    { _id: sessionId, status: "pending" },
    { $set: { status: "credited" } },
    { returnDocument: "after" },
  );

  if (!claimed) {
    return {
      ok: false,
      error: "ALREADY_CLAIMED",
      message: "Kredit sudah diklaim.",
    };
  }

  // 4. Masukkan kredit ke User & Ledger
  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { credits: claimed.credits } },
    { returnDocument: "after", projection: { credits: 1 } },
  );

  await CreditTransaction.create({
    user: userId,
    type: "ad_reward",
    amount: claimed.credits,
    balanceAfter: user.credits,
    refKind: "ad_session",
    refId: sessionId,
    key: `ad_reward:${sessionId}`, // Idempotency key
  });

  return { ok: true, credits: claimed.credits, balance: user.credits };
}
