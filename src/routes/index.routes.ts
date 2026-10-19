import { Router } from "express";
import authRouter from "./authRoutes.js";
import briefRouter from "./briefRoutes.js";
import paymentRoutes from "./paymentRoutes.js";
import projectRouter from "./projectRoutes.js";
import adminRouter from "./adminRoutes.js";

const appRouter = Router();

appRouter.use("/auth", authRouter);
appRouter.use("/briefs", briefRouter);
appRouter.use("/projects", projectRouter);
appRouter.use("/payments", paymentRoutes);
appRouter.use("/admin", adminRouter);

export default appRouter;