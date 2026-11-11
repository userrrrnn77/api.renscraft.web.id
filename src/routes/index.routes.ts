import { Router } from "express";
import healthRouter from "./healthRoutes.js";
import authRouter from "./authRoutes.js";
import briefRouter from "./briefRoutes.js";
import paymentRoutes from "./paymentRoutes.js";
import projectRouter from "./projectRoutes.js";
import adminRouter from "./adminRoutes.js";
import redeemRouter from "./redeemRoutes.js";
import referralRouter from "./referralRoutes.js";
import dynamicRouter from "./dynamicRoutes.js";
import adsRoutes from "./adsRoutes.js"; // bikin file adsRoutes.js dulu

const appRouter = Router();

appRouter.use("/health", healthRouter);
appRouter.use("/auth", authRouter);
appRouter.use("/briefs", briefRouter);
appRouter.use("/projects", projectRouter);
appRouter.use("/payments", paymentRoutes);
appRouter.use("/admin", adminRouter);
appRouter.use("/redeem", redeemRouter);
appRouter.use("/referral", referralRouter);
appRouter.use("/dynamic", dynamicRouter);
appRouter.use("/ads", adsRoutes);

export default appRouter;
