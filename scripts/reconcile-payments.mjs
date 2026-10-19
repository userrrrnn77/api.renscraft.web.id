// scripts/reconcile-payments.mjs

// scripts/reconcile-payments.mjs  (npm run payments:reconcile)
//
// Catches what a missed webhook leaves behind (PRD 7.5). Safe to run as often as you
// like: every step goes through the same atomic transitions as the webhook.
//
//   1. pending / challenge orders older than 5 minutes -> ask Midtrans, apply the answer
//      (an order past expiresAt that Midtrans does not know becomes "expired")
//   2. paid && credited=false older than 1 minute      -> finish the crediting
//      (only happens on a standalone MongoDB without transactions, see paymentService.ts)
//
// Run it from the server/ folder (it reads .env there). On a serverless host, schedule it
// with a cron; tsx is a devDependency, so install it there too.
import "dotenv/config";
import mongoose from "mongoose";
import { connectToDatabase } from "../src/config/db.js";
import { isPaymentsEnabled } from "../src/config/env.js";
import { PaymentOrder } from "../src/models/PaymentOrder.js";
import { createMidtransGateway } from "../src/services/payments/midtransGateway.js";
import {
  finishCredit,
  reconcileOrder,
} from "../src/services/payments/paymentService.js";

const MINUTE = 60_000;
const OPEN_AFTER_MS = 5 * MINUTE;
const UNCREDITED_AFTER_MS = 1 * MINUTE;
const BATCH = 200;

const messageOf = (err) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 300);

async function main() {
  if (!isPaymentsEnabled()) {
    console.log("[Reconcile] PAYMENTS_ENABLED=false, nothing to do");
    return 0;
  }
  if (!String(process.env.MONGODB_URI ?? "").trim()) {
    console.error("[Reconcile] MONGODB_URI is not set");
    return 1;
  }

  await connectToDatabase();
  const gateway = createMidtransGateway();
  const now = new Date();

  const stats = {
    open: 0,
    applied: 0,
    stale: 0,
    ignored: 0,
    flagged: 0,
    credited: 0,
    unconfirmed: 0,
    noUser: 0,
    errors: 0,
  };

  // 1. open orders
  const open = await PaymentOrder.find({
    status: { $in: ["pending", "challenge"] },
    createdAt: { $lt: new Date(now.getTime() - OPEN_AFTER_MS) },
  })
    .sort({ createdAt: 1 })
    .limit(BATCH);

  for (const order of open) {
    stats.open++;
    try {
      const result = await reconcileOrder(order, gateway, now);
      stats[result.outcome]++;
    } catch (err) {
      stats.errors++;
      console.error(
        `[Reconcile] order=${order.orderId} failed: ${messageOf(err)}`,
      );
    }
  }

  // 2. paid but never credited
  const uncredited = await PaymentOrder.find({
    status: "paid",
    credited: false,
    paidAt: { $lt: new Date(now.getTime() - UNCREDITED_AFTER_MS) },
  })
    .sort({ paidAt: 1 })
    .limit(BATCH);

  for (const order of uncredited) {
    try {
      const result = await finishCredit(order);
      if (result === "credited") stats.credited++;
      else if (result === "unconfirmed") stats.unconfirmed++;
      else stats.noUser++;
    } catch (err) {
      stats.errors++;
      console.error(
        `[Reconcile] credit order=${order.orderId} failed: ${messageOf(err)}`,
      );
    }
  }

  console.log(`[Reconcile] done ${JSON.stringify(stats)}`);
  return stats.errors > 0 ? 1 : 0;
}

main()
  .then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`[Reconcile] fatal: ${messageOf(err)}`);
      process.exitCode = 1;
    },
  )
  .finally(() => mongoose.disconnect().catch(() => undefined));
