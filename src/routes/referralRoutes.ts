// src/routes/referralRoutes.ts
import { Router } from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { getMyReferral } from "../controllers/referralController.js";

const router = Router();

router.use(authMiddleware);
router.get("/me", getMyReferral);

export default router;
