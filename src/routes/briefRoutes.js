// routes/briefRoutes.js
//
// authMiddleware dipasang di server.js saat mount (sama seperti /api/projects):
//   app.use("/api/briefs", authMiddleware, briefRouter);
import { Router } from "express";
import {
  createBrief,
  getBrief,
  patchBrief,
} from "../controllers/briefController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router();

router.use(authMiddleware);

router.post("/", createBrief);
router.get("/:id", getBrief);
router.patch("/:id", patchBrief);

export default router;