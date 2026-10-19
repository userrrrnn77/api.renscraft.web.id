// src/controllers/paymentController.ts

import type { Request, Response } from "express";
import { getMidtransConfig, getPublicAppUrl } from "../config/env.js";
import { PaymentOrder } from "../models/PaymentOrder.js";
import type { IPaymentOrder } from "../models/PaymentOrder.js";
import { User } from "../models/User.js";
import { snapJsUrl } from "../services/payments/midtransGateway.js";
import type { PaymentGateway } from "../services/payments/midtransGateway.js";
import {
  isRecord,
  isValidSignature,
  parseIdr,
  parseNotification,
} from "../services/payments/midtransStatus.js";
import type { MidtransStatus } from "../services/payments/midtransStatus.js";
import {
  applyMidtransStatus,
  reconcileOrder,
} from "../services/payments/paymentService.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { fail } from "../utils/apiError.js";
import { generateOrderId, ORDER_ID_RE } from "../utils/orderId.js";
import { CREDIT_PACKAGES, findPackage } from "../utils/packages.js";
import type { CreditPackage } from "../utils/packages.js";

const ORDER_TTL_MINUTES = 60;
const REUSE_WINDOW_MS = 10 * 60_000;
const MAX_PENDING_ORDERS = 3;
const MAX_ORDERS_PER_HOUR = 10;
const HOUR_MS = 60 * 60_000;
const RECONCILE_AFTER_MS = 20_000;

interface AuthedRequest extends Request {
  user?: { userId?: string };
}

const userIdOf = (req: Request): string | null => {
  const id = (req as AuthedRequest).user?.userId;
  return typeof id === "string" && id ? id : null;
};

const messageOf = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 300);

const logId = (value: string): string =>
  value.slice(0, 60).replace(/[^\w.-]/g, "?");

const isDuplicateKey = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  (err as { code?: unknown }).code === 11000;

interface CheckoutView {
  orderId: string;
  snapToken?: string | undefined;
  redirectUrl?: string | undefined;
  amount: number;
  credits: number;
  expiresAt: Date;
}

const checkoutBody = (o: CheckoutView) => ({
  orderId: o.orderId,
  snapToken: o.snapToken,
  redirectUrl: o.redirectUrl,
  amount: o.amount,
  credits: o.credits,
  expiresAt: o.expiresAt,
});

const orderBody = (
  o: Pick<
    IPaymentOrder,
    "orderId" | "status" | "credits" | "amount" | "credited"
  > & { paidAt?: Date | undefined },
) => ({
  orderId: o.orderId,
  status: o.status,
  credits: o.credits,
  amount: o.amount,
  credited: o.credited,
  paidAt: o.paidAt ?? null,
});

type ListView = Pick<
  IPaymentOrder,
  | "orderId"
  | "packageId"
  | "status"
  | "credits"
  | "amount"
  | "credited"
  | "createdAt"
  | "expiresAt"
> & {
  paymentType?: string | undefined;
  paidAt?: Date | undefined;
  snapToken?: string | undefined;
  redirectUrl?: string | undefined;
};

const listBody = (o: ListView, now: Date) => ({
  orderId: o.orderId,
  packageId: o.packageId,
  status: o.status,
  credits: o.credits,
  amount: o.amount,
  credited: o.credited,
  paymentType: o.paymentType ?? null,
  createdAt: o.createdAt,
  expiresAt: o.expiresAt,
  paidAt: o.paidAt ?? null,
  ...(o.status === "pending" &&
  o.expiresAt.getTime() > now.getTime() &&
  o.snapToken
    ? { snapToken: o.snapToken, redirectUrl: o.redirectUrl ?? null }
    : {}),
});

export function createPaymentController(
  gateway: PaymentGateway,
  clock: () => Date = () => new Date(),
) {
  async function insertOrder(owner: string, pkg: CreditPackage, now: Date) {
    const expiresAt = new Date(now.getTime() + ORDER_TTL_MINUTES * 60_000);
    for (let attempt = 0; ; attempt++) {
      try {
        return await PaymentOrder.create({
          orderId: generateOrderId(now),
          owner,
          packageId: pkg.id,
          credits: pkg.credits,
          amount: pkg.amount,
          status: "pending",
          expiresAt,
        });
      } catch (err) {
        if (attempt < 2 && isDuplicateKey(err)) continue;
        throw err;
      }
    }
  }

  const getConfig = asyncHandler(async (_req: Request, res: Response) => {
    const { clientKey, isProduction } = getMidtransConfig();
    res.json({
      packages: CREDIT_PACKAGES.map((p) => ({
        id: p.id,
        credits: p.credits,
        amount: p.amount,
        label: p.label,
      })),
      clientKey,
      snapUrl: snapJsUrl(isProduction),
      isProduction,
    });
  });

  const checkout = asyncHandler(async (req: Request, res: Response) => {
    const userId = userIdOf(req);
    if (!userId) {
      fail(res, 401, "PAYMENTS_NOT_AUTHENTICATED", {}, "Not authenticated");
      return;
    }

    const pkg = findPackage(
      isRecord(req.body) ? req.body.packageId : undefined,
    );
    if (!pkg) {
      fail(res, 400, "PAYMENTS_UNKNOWN_PACKAGE", {}, "Unknown package");
      return;
    }

    const user = await User.findById(userId).select("name email").lean();
    if (!user) {
      fail(
        res,
        401,
        "PAYMENTS_ACCOUNT_NOT_FOUND",
        {},
        "Account not found, please sign in again.",
      );
      return;
    }

    const now = clock();

    const existing = await PaymentOrder.findOne({
      owner: userId,
      packageId: pkg.id,
      status: "pending",
      createdAt: { $gte: new Date(now.getTime() - REUSE_WINDOW_MS) },
      expiresAt: { $gt: now },
      snapToken: { $exists: true },
    }).sort({ createdAt: -1 });
    if (existing?.snapToken) {
      res.status(200).json(checkoutBody(existing));
      return;
    }

    const [pendingCount, recentCount] = await Promise.all([
      PaymentOrder.countDocuments({
        owner: userId,
        status: "pending",
        expiresAt: { $gt: now },
      }),
      PaymentOrder.countDocuments({
        owner: userId,
        createdAt: { $gte: new Date(now.getTime() - HOUR_MS) },
      }),
    ]);
    if (pendingCount >= MAX_PENDING_ORDERS) {
      fail(
        res,
        429,
        "PAYMENTS_TOO_MANY_PENDING",
        { max: MAX_PENDING_ORDERS },
        "You have too many unpaid orders. Finish or wait for them to expire.",
      );
      return;
    }
    if (recentCount >= MAX_ORDERS_PER_HOUR) {
      fail(
        res,
        429,
        "PAYMENTS_TOO_MANY_ATTEMPTS",
        { max: MAX_ORDERS_PER_HOUR },
        "Too many payment attempts, please try again in a while.",
      );
      return;
    }

    const order = await insertOrder(userId, pkg, now);

    let snap: { token: string; redirectUrl: string };
    try {
      const finishUrl = getPublicAppUrl();
      snap = await gateway.createSnapTransaction({
        orderId: order.orderId,
        amount: order.amount,
        packageId: pkg.id,
        itemName: `Renscraft ${pkg.credits} credits`,
        customer: { firstName: user.name, email: user.email },
        expiryMinutes: ORDER_TTL_MINUTES,
        ...(finishUrl ? { finishUrl } : {}),
      });
    } catch (err) {
      await PaymentOrder.updateOne(
        { _id: order._id, status: "pending" },
        { $set: { status: "failed" } },
      ).catch(() => undefined);
      console.error(
        `[Payments] snap token failed order=${order.orderId}: ${messageOf(err)}`,
      );
      fail(
        res,
        502,
        "PAYMENTS_GATEWAY_DOWN",
        {},
        "Payment service is unavailable, try again later",
      );
      return;
    }

    order.snapToken = snap.token;
    order.redirectUrl = snap.redirectUrl;
    await PaymentOrder.updateOne(
      { _id: order._id },
      { $set: { snapToken: snap.token, redirectUrl: snap.redirectUrl } },
    );

    console.log(`[Payments] checkout order=${order.orderId} package=${pkg.id}`);
    res.status(201).json(checkoutBody(order));
  });

  const getOrder = asyncHandler(async (req: Request, res: Response) => {
    const userId = userIdOf(req);
    if (!userId) {
      fail(res, 401, "PAYMENTS_NOT_AUTHENTICATED", {}, "Not authenticated");
      return;
    }

    const orderId = req.params.orderId;
    if (!orderId || !ORDER_ID_RE.test(orderId)) {
      fail(res, 404, "PAYMENTS_ORDER_NOT_FOUND", {}, "Order not found");
      return;
    }
    let order = await PaymentOrder.findOne({ orderId, owner: userId });
    if (!order) {
      fail(res, 404, "PAYMENTS_ORDER_NOT_FOUND", {}, "Order not found");
      return;
    }

    const now = clock();
    const open = order.status === "pending" || order.status === "challenge";
    if (
      open &&
      now.getTime() - order.createdAt.getTime() > RECONCILE_AFTER_MS
    ) {
      try {
        await reconcileOrder(order, gateway, now);
        order =
          (await PaymentOrder.findOne({ orderId, owner: userId })) ?? order;
      } catch (err) {
        console.error(
          `[Payments] poll reconcile failed order=${orderId}: ${messageOf(err)}`,
        );
      }
    }

    res.json(orderBody(order));
  });

  const listOrders = asyncHandler(async (req: Request, res: Response) => {
    const userId = userIdOf(req);
    if (!userId) {
      fail(res, 401, "PAYMENTS_NOT_AUTHENTICATED", {}, "Not authenticated");
      return;
    }
    const now = clock();
    const orders = await PaymentOrder.find({ owner: userId })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    res.json({ orders: orders.map((o) => listBody(o, now)) });
  });

  const notification = asyncHandler(async (req: Request, res: Response) => {
    const n = parseNotification(req.body);
    if (!n) {
      fail(
        res,
        400,
        "PAYMENTS_INVALID_NOTIFICATION",
        {},
        "Invalid notification",
      );
      return;
    }
    const id = logId(n.order_id);

    try {
      const { serverKey } = getMidtransConfig();
      if (!isValidSignature(n, serverKey)) {
        console.warn(`[Payments] bad signature order=${id}`);
        fail(res, 403, "PAYMENTS_INVALID_SIGNATURE", {}, "Invalid signature");
        return;
      }

      const order = await PaymentOrder.findOne({ orderId: n.order_id });
      if (!order) {
        console.warn(`[Payments] notification for unknown order=${id}`);
        fail(res, 404, "PAYMENTS_UNKNOWN_ORDER", {}, "Unknown order");
        return;
      }

      const gross = parseIdr(n.gross_amount);
      if (gross === null || gross !== order.amount) {
        await PaymentOrder.updateOne(
          { orderId: order.orderId },
          { $set: { flag: "amount_mismatch" } },
        );
        console.error(
          `[Payments] amount mismatch order=${order.orderId} expected=${order.amount}`,
        );
        res.status(200).json({ ok: true });
        return;
      }

      let confirmed: MidtransStatus;
      try {
        confirmed = await gateway.getTransactionStatus(order.orderId);
      } catch (err) {
        console.error(
          `[Payments] status check failed order=${order.orderId}: ${messageOf(err)}`,
        );
        fail(
          res,
          503,
          "PAYMENTS_STATUS_UNAVAILABLE",
          {},
          "Could not confirm the payment yet",
        );
        return;
      }

      const result = await applyMidtransStatus(order, confirmed, clock());
      console.log(
        `[Payments] notification order=${order.orderId} midtrans=${confirmed.transaction_status} type=${confirmed.payment_type ?? "-"} -> ${result.outcome}`,
      );

      res.status(200).json({ ok: true });
    } catch (err) {
      console.error(
        `[Payments] notification failed order=${id}: ${messageOf(err)}`,
      );
      fail(
        res,
        503,
        "PAYMENTS_TEMP_ERROR",
        {},
        "Temporary error, please retry",
      );
    }
  });

  return { getConfig, checkout, getOrder, listOrders, notification };
}
