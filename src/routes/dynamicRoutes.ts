// src/routes/dynamicRoutes.ts
import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { isDynamicAppsEnabled } from "../config/env.js";
import { fail } from "../utils/apiError.js";
import * as ctrl from "../controllers/dynamicAppController.js";

const router = Router();

router.get("/config", (_req, res) => {
  res.json({ enabled: isDynamicAppsEnabled() });
});

// Middleware Flag Check
router.use((_req: Request, res: Response, next: NextFunction) => {
  if (!isDynamicAppsEnabled()) {
    return fail(
      res,
      503,
      "DYNAMIC_APPS_DISABLED",
      {},
      "Dynamic apps feature is disabled",
    );
  }
  next();
});

// ─── PUBLIC ROUTES (Tanpa Auth) ─────────────────────────────────────────────
// Ditaruh di atas authMiddleware biar bisa diakses publik
router.get("/public/:slug", ctrl.getPublicApp);

// ─── PROTECTED ROUTES (Wajib Auth) ──────────────────────────────────────────
router.use(authMiddleware);

// Apps
router.get("/apps", ctrl.listApps);
router.post("/apps", ctrl.createApp);
router.get("/apps/:id", ctrl.getApp);
router.post("/apps/:id/publish", ctrl.publishApp);
router.post("/apps/:id/unpublish", ctrl.unpublishApp);

// Collections
router.get("/apps/:id/collections", ctrl.listCollections);
router.post("/apps/:id/collections", ctrl.createCollection);
router.patch("/apps/:id/collections/:cid", ctrl.updateCollection);
router.delete("/apps/:id/collections/:cid", ctrl.deleteCollection);

// Documents (owner view)
router.get("/apps/:id/collections/:cid/documents", ctrl.listDocuments);
router.delete(
  "/apps/:id/collections/:cid/documents/:docId",
  ctrl.deleteDocument,
);

export default router;
