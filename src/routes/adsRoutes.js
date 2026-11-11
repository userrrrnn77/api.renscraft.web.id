// src/routes/adsRoutes.js

import { Router } from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { startAd, claimAd } from "../controllers/adsController.js";

const router = Router();
router.use(authMiddleware);

router.post("/session", startAd);
router.post("/claim", claimAd);

export default router;
