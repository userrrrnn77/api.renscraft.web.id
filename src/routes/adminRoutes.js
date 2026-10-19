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

export default adminRouter;