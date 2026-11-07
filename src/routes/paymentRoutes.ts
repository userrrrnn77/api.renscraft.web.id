// src/routes/paymentRoutes.ts
import express, { Router } from "express";
import type { Request, RequestHandler } from "express";
import { canUseMidtrans, getMidtransConfig } from "../config/env.js";
import { createPaymentController } from "../controllers/paymentController.js";
import {
  createManual,
  getManualConfig,
  uploadProof,
} from "../controllers/manualPaymentController.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { fail } from "../utils/apiError.js";
import { verifySession } from "../utils/jwt.js";
import { signupConfig } from "../services/abuseGuard.js";
import { creditCosts } from "../services/credits.js";
import { createMidtransGateway } from "../services/payments/midtransGateway.js";
import type { PaymentGateway } from "../services/payments/midtransGateway.js";
import { CREDIT_PACKAGES } from "../utils/packages.js";

// Email dari session cookie yang sudah di-sign (payload JWT: { userId, email }).
// Buat endpoint publik yang jawabannya beda per akun. null = tamu / token rusak.
const sessionEmail = (req: Request): string | null => {
  const token: unknown = req.cookies?.token;
  if (typeof token !== "string" || !token) return null;
  try {
    const session: unknown = verifySession(token);
    if (
      typeof session === "object" &&
      session !== null &&
      "email" in session &&
      typeof session.email === "string"
    ) {
      return session.email;
    }
  } catch {
    // token kadaluarsa / rusak: perlakukan sebagai tamu
  }
  return null;
};

// Pengganti requirePaymentsEnabled. Harus jalan SETELAH authMiddleware (butuh req.user).
// PAYMENTS_ENABLED=true -> semua user. false -> cuma email di MIDTRANS_TEST_EMAILS.
const requireMidtransAccess: RequestHandler = (req, res, next) => {
  const email = (req as Request & { user?: { email?: unknown } }).user?.email;
  if (!canUseMidtrans(typeof email === "string" ? email : null)) {
    fail(res, 503, "PAYMENTS_DISABLED", {}, "Midtrans payments are disabled");
    return;
  }
  try {
    getMidtransConfig(); // kunci Midtrans harus lengkap
  } catch {
    fail(
      res,
      503,
      "PAYMENTS_DISABLED",
      {},
      "Midtrans payments are not configured",
    );
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

const getPublicPackages: RequestHandler = (req, res) => {
  const email = sessionEmail(req);
  // Jawabannya tergantung siapa yang nanya: cache bersama ga boleh nyampur antar user
  res.set("Vary", "Cookie");
  res.set("Cache-Control", email ? "private, no-store" : "public, max-age=60");
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
      midtrans: canUseMidtrans(email),
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
    authMiddleware,
    requireMidtransAccess,
    controller.getConfig,
  );
  router.post(
    "/checkout",
    authMiddleware,
    requireMidtransAccess,
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
