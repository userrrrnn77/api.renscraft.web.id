// src/middleware/adminMiddleware.js

import { isTokenError, verifyAdminSession } from "../utils/jwt.js";
import { fail } from "../utils/apiError.js";

export const adminMiddleware = (req, res, next) => {
  const token = req.cookies?.admin_token;

  if (!token) {
    return fail(res, 401, "ADMIN_REQUIRED", {}, "Admin access required");
  }

  try {
    req.admin = verifyAdminSession(token);
  } catch (err) {
    if (isTokenError(err)) {
      return fail(
        res,
        401,
        "ADMIN_SESSION_EXPIRED",
        {},
        "Admin session expired or invalid",
      );
    }
    return next(err);
  }

  next();
};