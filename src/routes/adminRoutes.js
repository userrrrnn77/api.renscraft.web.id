// src/routes/adminRoutes.js

import { Router } from "express";
import {
  adminLogin,
  adminLogout,
  adminMe,
  adminStats,
  adminListUsers,
  adminListProjects,
  adminListOrders,
  adminGrantCredits,
  adminListManualOrders,
  adminApproveManual,
  adminRejectManual,
  adminListRedeemCodes,
  adminCreateRedeemCode,
  adminDeleteRedeemCode,
  adminListDynamicApps,
  adminSuspendDynamicApp,
  adminRestoreDynamicApp,
  adminListRemakes,
  adminUnpublishProject,
} from "../controllers/adminController.js";
import { adminMiddleware } from "../middleware/adminMiddleware.js";

const adminRouter = Router();

adminRouter.post("/login", adminLogin);

adminRouter.use(adminMiddleware);

adminRouter.post("/logout", adminLogout);
adminRouter.get("/me", adminMe);
adminRouter.get("/stats", adminStats);
adminRouter.get("/users", adminListUsers);
adminRouter.get("/projects", adminListProjects);
adminRouter.get("/orders", adminListOrders);
adminRouter.post("/users/:id/credits", adminGrantCredits);

// Manual transfer review
adminRouter.get("/manual", adminListManualOrders);
adminRouter.post("/manual/:orderId/approve", adminApproveManual);
adminRouter.post("/manual/:orderId/reject", adminRejectManual);

// Redeem codes
adminRouter.get("/redeem", adminListRedeemCodes);
adminRouter.post("/redeem", adminCreateRedeemCode);
adminRouter.delete("/redeem/:id", adminDeleteRedeemCode);

// Dynamic apps moderation
adminRouter.get("/dynamic", adminListDynamicApps);
adminRouter.post("/dynamic/:id/suspend", adminSuspendDynamicApp);
adminRouter.post("/dynamic/:id/restore", adminRestoreDynamicApp);

// Remakes (takedown)
adminRouter.get("/remakes", adminListRemakes);
adminRouter.post("/projects/:id/unpublish", adminUnpublishProject);

export default adminRouter;
