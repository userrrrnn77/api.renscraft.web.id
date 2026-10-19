// src/middleware/authMiddleware.js

import { isTokenError, verifySession } from "../utils/jwt.js";
import { fail } from "../utils/apiError.js";

export const authMiddleware = (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return fail(
      res,
      401,
      "AUTH_NOT_AUTHENTICATED",
      {},
      "Access denied no token provided",
    );
  }

  try {
    req.user = verifySession(token);
  } catch (err) {
    if (isTokenError(err)) {
      return fail(
        res,
        401,
        "AUTH_SESSION_EXPIRED",
        {},
        "Session expired or invalid, please sign in again.",
      );
    }
    // bukan salah token (mis. JWT_SECRET hilang): error server, biar
    // error middleware yang urus
    return next(err);
  }

  next();
};