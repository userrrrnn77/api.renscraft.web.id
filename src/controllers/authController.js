// src/controllers/authController.js

import { User } from "../models/User.js";
import { evaluateFreeSignup } from "../services/abuseGuard.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { signSession } from "../utils/jwt.js";
import { fail } from "../utils/apiError.js";

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

const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 128;

const isText = (value, max) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

const isPassword = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_PASSWORD_LENGTH;

export const register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body ?? {};

  if (!name || !email || !password) {
    return fail(
      res,
      400,
      "AUTH_INVALID_CREDENTIALS",
      {},
      "Name email and password are required",
    );
  }

  if (
    !isText(name, MAX_NAME_LENGTH) ||
    !isText(email, MAX_EMAIL_LENGTH) ||
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

  const trimmedEmail = email.toLowerCase().trim();

  const existing = await User.findOne({ email: trimmedEmail });
  if (existing) {
    return fail(
      res,
      400,
      "AUTH_EMAIL_EXISTS",
      {},
      "An account with this email already exists",
    );
  }

  const grant = await evaluateFreeSignup(req);

  let user;
  try {
    user = await User.create({
      name,
      email: trimmedEmail,
      password,
      provider: "local",
      credits: grant.credits,
      ...(grant.ipHash ? { signupIpHash: grant.ipHash } : {}),
    });
  } catch (err) {
    if (err?.code === 11000) {
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

  setSessionCookie(res, { userId: user._id.toString(), email: user.email });

  res.status(201).json({
    user: {
      _id: user._id,
      name: user.name,
      email: user.email,
      credits: user.credits,
    },
    freeCredits: grant.credits,
    freeCreditsReason: grant.reason,
  });
});

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
    return fail(
      res,
      401,
      "AUTH_NOT_AUTHENTICATED",
      {},
      "Not authenticated",
    );
  }

  const user = await User.findById(req.user.userId).select("-password");

  if (!user) {
    return fail(res, 404, "AUTH_USER_NOT_FOUND", {}, "User not found");
  }

  res.json({ user });
});