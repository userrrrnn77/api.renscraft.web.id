// src/routes/redeemRoutes.ts
import { Router } from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { redeem } from "../controllers/redeemController.js";

const router = Router();
router.use(authMiddleware);
router.post("/", redeem);
export default router;
