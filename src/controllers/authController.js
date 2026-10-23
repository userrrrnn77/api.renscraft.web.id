// src/controllers/authController.js

import bcrypt from "bcrypt";
import { User } from "../models/User.js";
import { Referral } from "../models/Referral.js";
import { CreditTransaction } from "../models/CreditTransaction.js";
import {
  evaluateFreeSignup,
  getClientIp,
  hashIp,
} from "../services/abuseGuard.js";
import {
  consumeOtp,
  createRegisterOtp,
  resendRegisterOtp,
  verifyRegisterOtp,
} from "../services/otp.js";
import {
  ensureReferralForUser,
  normalizeReferralCode,
  processReferralRewards,
  rewardOwner,
} from "../services/referral.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { signSession } from "../utils/jwt.js";
import { fail } from "../utils/apiError.js";

// ─── Session cookie ─────────────────────────────────────────────────────────

export const setSessionCookie = (res, payload) => {
  const token = signSession(payload);
  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/",
  });
};

// ─── Validation constants ───────────────────────────────────────────────────

const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 128;
const BCRYPT_ROUNDS = 10;

const isText = (value, max) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

const isPassword = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_PASSWORD_LENGTH;

const isValidEmailShape = (email) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);

// ─── Register step 1: request OTP ───────────────────────────────────────────

export const registerRequestOtp = asyncHandler(async (req, res) => {
  const rawName =
    typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const rawEmail =
    typeof req.body?.email === "string" ? req.body.email.trim() : "";
  const password =
    typeof req.body?.password === "string" ? req.body.password : "";
  const rawReferral = req.body?.referralCode;

  if (!rawName || !rawEmail || !password) {
    return fail(
      res,
      400,
      "AUTH_INVALID_CREDENTIALS",
      {},
      "Name email and password are required",
    );
  }

  if (
    !isText(rawName, MAX_NAME_LENGTH) ||
    !isText(rawEmail, MAX_EMAIL_LENGTH) ||
    !isPassword(password)
  ) {
    return fail(
      res,
      400,
      "AUTH_INVALID_CREDENTIALS",
      {},
      "Invalid name, email or password",
    );
  }

  const email = rawEmail.toLowerCase();
  if (!isValidEmailShape(email)) {
    return fail(
      res,
      400,
      "AUTH_INVALID_CREDENTIALS",
      {},
      "Invalid email address",
    );
  }

  const existing = await User.findOne({ email }).lean();
  if (existing) {
    return fail(
      res,
      400,
      "AUTH_EMAIL_EXISTS",
      {},
      "An account with this email already exists",
    );
  }

  const referralCode = normalizeReferralCode(rawReferral);

  // Hash the password NOW so the OTP row never stores plaintext.
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  try {
    const { otpId, expiresAt, resendAvailableAt } = await createRegisterOtp({
      email,
      payload: { name: rawName, passwordHash, referralCode },
    });

    res.status(201).json({
      otpId,
      email,
      expiresAt,
      resendAvailableAt,
    });
  } catch (err) {
    console.error("[Auth] register/request-otp failed:", err);
    return fail(
      res,
      503,
      "EMAIL_SEND_FAILED",
      {},
      "Could not send the verification email, try again",
    );
  }
});

// ─── Register step 2: verify OTP (creates the user) ─────────────────────────

const OTP_FAILURE_STATUS = {
  not_found: [
    400,
    "OTP_NOT_FOUND",
    "Verification code not found, please start over",
  ],
  expired: [
    400,
    "OTP_EXPIRED",
    "Verification code expired, please request a new one",
  ],
  too_many_attempts: [
    400,
    "OTP_TOO_MANY_ATTEMPTS",
    "Too many attempts, please start over",
  ],
  wrong_code: [400, "OTP_WRONG_CODE", "Incorrect verification code"],
};

export const registerVerifyOtp = asyncHandler(async (req, res) => {
  const otpId =
    typeof req.body?.otpId === "string" ? req.body.otpId.trim() : "";
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";

  if (!otpId || !code) {
    return fail(res, 400, "OTP_REQUIRED", {}, "otpId and code are required");
  }
  if (!/^\d{4,8}$/.test(code)) {
    return fail(res, 400, "OTP_INVALID_FORMAT", {}, "Invalid code format");
  }

  const verified = await verifyRegisterOtp(otpId, code);
  if (!verified.ok) {
    const [status, errCode, msg] = OTP_FAILURE_STATUS[verified.reason];
    return fail(res, status, errCode, {}, msg);
  }

  const { email, payload } = verified;
  const ip = getClientIp(req);
  const signupIpHash = ip ? hashIp(ip) : null;

  // 1. Tentukan kredit awal (SELALU dapet free signup dulu, mau pake referral atau nggak)
  const grant = await evaluateFreeSignup(req);
  let initialCredits = grant.credits; // Ini bakal dapet 15 (atau 0 kalau IP limit)
  let creditsSource = initialCredits > 0 ? "free_signup" : "none";

  // 2. Bikin user
  let user;
  try {
    user = await User.create({
      name: payload.name,
      email,
      password: payload.passwordHash,
      provider: "local",
      credits: initialCredits,
      ...(signupIpHash ? { signupIpHash } : {}),
    });
  } catch (err) {
    if (err?.code === 11000) {
      await consumeOtp(otpId);
      return fail(
        res,
        400,
        "AUTH_EMAIL_EXISTS",
        {},
        "An account with this email already exists",
      );
    }
    throw err;
  }

  // 3. Proses referral (TAMBAHIN 10 kredit ke user yang baru daftar)
  let referralApplied = false;
  let finalCredits = initialCredits;

  if (payload.referralCode) {
    const result = await processReferralRewards(
      user._id,
      payload.referralCode,
      signupIpHash,
      initialCredits,
    );
    if (result.applied) {
      referralApplied = true;
      // processReferralRewards udah nambahin kredit di database, jadi di sini tinggal jumlahin buat response
      finalCredits = initialCredits + result.credits;
      creditsSource = "referral"; // Flag buat nampilin toast
    }
  }

  // 4. Bikin referral code buat user baru
  try {
    await ensureReferralForUser(user._id, signupIpHash);
  } catch (err) {
    console.error("[Referral] failed to create code for new user:", err);
  }

  await consumeOtp(otpId);
  setSessionCookie(res, { userId: user._id.toString(), email: user.email });

  res.status(201).json({
    user: {
      _id: user._id,
      name: user.name,
      email: user.email,
      credits: finalCredits, // 25 (kalau dapet free + referral)
    },
    referralApplied,
    creditsAwarded: finalCredits,
    creditsSource, // "referral" | "free_signup" | "none"
  });
});

// ─── Register step 3: resend OTP ────────────────────────────────────────────

export const registerResendOtp = asyncHandler(async (req, res) => {
  const otpId =
    typeof req.body?.otpId === "string" ? req.body.otpId.trim() : "";
  if (!otpId) {
    return fail(res, 400, "OTP_REQUIRED", {}, "otpId is required");
  }

  try {
    const result = await resendRegisterOtp(otpId);
    if (!result) {
      return fail(
        res,
        429,
        "OTP_RESEND_LIMITED",
        {},
        "Please wait before requesting another code, or start over",
      );
    }
    res.json(result);
  } catch (err) {
    console.error("[Auth] register/resend-otp failed:", err);
    return fail(
      res,
      503,
      "EMAIL_SEND_FAILED",
      {},
      "Could not send the verification email, try again",
    );
  }
});

// ─── Login / logout / me (unchanged) ────────────────────────────────────────

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body ?? {};

  if (!isText(email, MAX_EMAIL_LENGTH) || !isPassword(password)) {
    return fail(
      res,
      400,
      "AUTH_INVALID_CREDENTIALS",
      {},
      "Email and password are required",
    );
  }

  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user) {
    return fail(
      res,
      401,
      "AUTH_INVALID_CREDENTIALS",
      {},
      "Invalid email or password",
    );
  }

  const isValid = await user.comparePassword(password);
  if (!isValid) {
    return fail(
      res,
      401,
      "AUTH_INVALID_CREDENTIALS",
      {},
      "Invalid email or password",
    );
  }

  setSessionCookie(res, { userId: user._id.toString(), email: user.email });

  res.status(200).json({
    user: {
      _id: user._id,
      name: user.name,
      email: user.email,
      credits: user.credits ?? 0,
    },
  });
});

export const logout = asyncHandler(async (_req, res) => {
  res.cookie("token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });

  res.json({ success: true });
});

export const me = asyncHandler(async (req, res) => {
  if (!req.user) {
    return fail(res, 401, "AUTH_NOT_AUTHENTICATED", {}, "Not authenticated");
  }

  const user = await User.findById(req.user.userId).select("-password");

  if (!user) {
    return fail(res, 404, "AUTH_USER_NOT_FOUND", {}, "User not found");
  }

  res.json({ user });
});
