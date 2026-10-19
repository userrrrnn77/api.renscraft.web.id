// src/utils/jwt.js

import jwt from "jsonwebtoken";
import { getJwtSecret } from "../config/env.js";

// Pinned on both sides, so a token can never choose its own algorithm.
const ALGORITHM = "HS256";
const SESSION_TTL = "30d";

export const signSession = (payload) =>
  jwt.sign(payload, getJwtSecret(), {
    algorithm: ALGORITHM,
    expiresIn: SESSION_TTL,
  });

export const verifySession = (token) =>
  jwt.verify(token, getJwtSecret(), { algorithms: [ALGORITHM] });

// True when the TOKEN is bad (expired, forged, malformed). Anything else thrown
// while verifying is a server problem (for example a missing JWT_SECRET) and must
// not be shown to the user as "your session expired".
export const isTokenError = (err) => err instanceof jwt.JsonWebTokenError;

// ─── Admin session ──────────────────────────────────────────────────────────
// Terpisah dari session user biasa: TTL lebih pendek (12 jam vs 30 hari), dan
// payload punya flag `admin: true` yang diverifikasi ulang di middleware.
// Reuse JWT_SECRET yang sama, karena cuma satu secret yang perlu dirotate
// kalau bocor — bukan dua.
const ADMIN_TTL = "12h";

export const signAdminSession = () =>
  jwt.sign({ admin: true }, getJwtSecret(), {
    algorithm: ALGORITHM,
    expiresIn: ADMIN_TTL,
  });

export const verifyAdminSession = (token) => {
  const payload = jwt.verify(token, getJwtSecret(), {
    algorithms: [ALGORITHM],
  });
  if (payload.admin !== true) {
    // Token valid secara kriptografis, tapi ini token user biasa.
    // Lempar error yang sama seperti token invalid, biar nggak bocorin
    // "token lu valid tapi bukan admin".
    throw new jwt.JsonWebTokenError("Not an admin token");
  }
  return payload;
};