// src/routes/authRoutes.js

import { Router } from "express";
import {
  login,
  logout,
  me,
  registerRequestOtp,
  registerVerifyOtp,
  registerResendOtp,
} from "../controllers/authController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { createSupabaseSession } from "../controllers/supabaseAuthController.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const authRouter = Router();

// Two-step registration (email OTP). The old synchronous POST /register is
// removed: registration MUST go through OTP now.
authRouter.post("/register/request-otp", registerRequestOtp);
authRouter.post("/register/verify-otp", registerVerifyOtp);
authRouter.post("/register/resend-otp", registerResendOtp);

authRouter.post("/login", login);
authRouter.post("/logout", logout);
authRouter.get("/me", authMiddleware, me);
authRouter.post("/supabase/session", asyncHandler(createSupabaseSession));

export default authRouter;
