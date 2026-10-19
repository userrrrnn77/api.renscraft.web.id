// src/routes/paymentRoutes.ts
import express, { Router } from "express";
import type { RequestHandler } from "express";
import { isPaymentsEnabled } from "../config/env.js";
import { createPaymentController } from "../controllers/paymentController.js";
import {
  createManual,
  getManualConfig,
  uploadProof,
} from "../controllers/manualPaymentController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { fail } from "../utils/apiError.js";
import { signupConfig } from "../services/abuseGuard.js";
import { creditCosts } from "../services/credits.js";
import { createMidtransGateway } from "../services/payments/midtransGateway.js";
import type { PaymentGateway } from "../services/payments/midtransGateway.js";
import { CREDIT_PACKAGES } from "../utils/packages.js";

const requirePaymentsEnabled: RequestHandler = (_req, res, next) => {
  if (!isPaymentsEnabled()) {
    fail(res, 503, "PAYMENTS_DISABLED", {}, "Midtrans payments are disabled");
    return;
  }
  next();
};

const isManualEnabled = () =>
  String(process.env.MANUAL_ENABLED ?? "false")
    .trim()
    .toLowerCase() === "true";

const requireManualEnabled: RequestHandler = (_req, res, next) => {
  if (!isManualEnabled()) {
    fail(res, 503, "MANUAL_DISABLED", {}, "Manual payment is disabled");
    return;
  }
  next();
};

const getPublicPackages: RequestHandler = (_req, res) => {
  res.set("Cache-Control", "public, max-age=60");
  res.json({
    packages: CREDIT_PACKAGES.map((p) => ({
      id: p.id,
      credits: p.credits,
      amount: p.amount,
      label: p.label,
    })),
    costs: creditCosts(),
    freeCredits: signupConfig().credits,
    methods: {
      midtrans: isPaymentsEnabled(),
      manual: isManualEnabled(),
    },
  });
};

export function createPaymentRouter(
  gateway: PaymentGateway = createMidtransGateway(),
): Router {
  const controller = createPaymentController(gateway);
  const router = Router();

  router.get("/packages", getPublicPackages);

  router.post("/midtrans/notification", controller.notification);

  router.get(
    "/config",
    requirePaymentsEnabled,
    authMiddleware,
    controller.getConfig,
  );
  router.post(
    "/checkout",
    requirePaymentsEnabled,
    authMiddleware,
    controller.checkout,
  );

  router.get(
    "/manual/config",
    requireManualEnabled,
    authMiddleware,
    getManualConfig,
  );
  router.post(
    "/manual/create",
    requireManualEnabled,
    authMiddleware,
    createManual,
  );
  router.post(
    "/manual/:orderId/proof",
    requireManualEnabled,
    authMiddleware,
    express.raw({ type: "image/*", limit: "6mb" }),
    uploadProof,
  );

  router.get("/orders", authMiddleware, controller.listOrders);
  router.get("/orders/:orderId", authMiddleware, controller.getOrder);

  return router;
}

export default createPaymentRouter();
