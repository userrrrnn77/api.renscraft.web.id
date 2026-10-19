// src/routes/authRoutes.js

import { Router } from "express";
import { login, logout, me, register } from "../controllers/authController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import {
  createSupabaseSession,
} from "../controllers/supabaseAuthController.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const authRouter = Router();

authRouter.post("/register", register);
authRouter.post("/login", login);
authRouter.post("/logout", logout);
authRouter.get("/me", authMiddleware, me);
authRouter.post(
  "/supabase/session",
  asyncHandler(createSupabaseSession),
);

export default authRouter;
