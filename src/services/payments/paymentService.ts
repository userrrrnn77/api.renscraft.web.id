// src/services/payments/paymentService.ts

// The database side of payments: crediting, clawback, and the one function that turns a
// CONFIRMED Midtrans status into an order change. The webhook, the status poll
// (GET /orders/:orderId) and scripts/reconcile-payments.mjs all call it, so the three
// behave the same.
//
// Two rules hold everywhere in this file:
//  1. A status change is ONE atomic findOneAndUpdate whose filter lists the allowed
//     source statuses (ALLOWED_FROM). Replays, races and out-of-order notifications
//     match nothing and are answered as "stale". Nothing is read first and written later.
//  2. Credits only move together with the order change that claims them: in one MongoDB
//     transaction when the server has a replica set (Atlas does), otherwise ledger-first
//     with the unique ledger key as the idempotency guard (see finishCredit).
import mongoose from "mongoose";
import type { ClientSession } from "mongoose";
import { CreditTransaction } from "../../models/CreditTransaction.js";
import { PaymentOrder } from "../../models/PaymentOrder.js";
import type {
  ILastMidtransStatus,
  IPaymentOrder,
  PaymentStatus,
} from "../../models/PaymentOrder.js";
import { User } from "../../models/User.js";
import { TransactionNotFoundError } from "./midtransGateway.js";
import type { PaymentGateway } from "./midtransGateway.js";
import {
  ALLOWED_FROM,
  mapMidtransStatus,
  parseIdr,
  trimStatus,
} from "./midtransStatus.js";
import type { MidtransStatus } from "./midtransStatus.js";

const REF_KIND = "payment_order";
const purchaseKey = (orderId: string): string => `purchase:${orderId}`;
const clawbackKey = (orderId: string): string => `clawback:${orderId}`;

const isDuplicateKey = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  (err as { code?: unknown }).code === 11000;

const opts = (session: ClientSession | null) => (session ? { session } : {});

// ── Transactions with a standalone-MongoDB fallback ─────────────────────────

// null = not tried yet. A standalone mongod cannot run transactions: the first attempt
// tells us, and after that we skip the attempt.
let transactionsSupported: boolean | null = null;

const isNoTransactionError = (err: unknown): boolean =>
  err instanceof Error &&
  /Transaction numbers are only allowed on a replica set member or mongos/i.test(
    err.message,
  );

// Runs `work` inside a transaction (session given) or, on a standalone MongoDB, without
// one (session null). `work` may run more than once: the driver retries it on a
// transient transaction error, so it must not keep state between runs.
async function runAtomically<T>(
  work: (session: ClientSession | null) => Promise<T>,
): Promise<T> {
  if (transactionsSupported !== false) {
    const session = await mongoose.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await work(session);
      });
      transactionsSupported = true;
      return result;
    } catch (err) {
      if (!isNoTransactionError(err)) throw err;
      transactionsSupported = false;
      console.warn(
        "[Payments] MongoDB has no replica set, so no transactions: crediting uses the ledger-first fallback",
      );
    } finally {
      await session.endSession();
    }
  }
  return work(null);
}

// ── What Midtrans said, as stored on the order ──────────────────────────────

interface StatusMeta {
  lastMidtransStatus: ILastMidtransStatus;
  paymentType?: string;
  transactionId?: string;
}

function buildMeta(status: MidtransStatus): StatusMeta {
  return {
    lastMidtransStatus: trimStatus(status),
    ...(status.payment_type ? { paymentType: status.payment_type } : {}),
    ...(status.transaction_id ? { transactionId: status.transaction_id } : {}),
  };
}

// ── Crediting (PRD 7.3) ─────────────────────────────────────────────────────

type CreditableOrder = Pick<IPaymentOrder, "orderId" | "owner" | "credits">;

// The part of crediting that runs WITHOUT a transaction. Order of the writes:
//   ledger row (unique key)  ->  $inc the user  ->  credited = true
// A duplicate ledger key means a row for this order already exists. Whether the $inc
// also ran cannot be known, so the order is marked credited + flagged for a human look
// rather than risking a second payout. Also used by the reconciler for orders that
// are `paid && !credited`. balanceAfter is an estimate here (read just before the $inc).
export async function finishCredit(
  order: CreditableOrder,
): Promise<"credited" | "unconfirmed" | "no_user"> {
  const user = await User.findById(order.owner).select("credits").lean();
  if (!user) {
    await PaymentOrder.updateOne(
      { orderId: order.orderId },
      { $set: { flag: "user_missing" } },
    );
    console.error(`[Payments] user missing for order=${order.orderId}`);
    return "no_user";
  }

  const key = purchaseKey(order.orderId);
  try {
    await CreditTransaction.create({
      user: order.owner,
      type: "purchase",
      amount: order.credits,
      balanceAfter: (user.credits ?? 0) + order.credits,
      refKind: REF_KIND,
      refId: order.orderId,
      key,
    });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    await PaymentOrder.updateOne(
      { orderId: order.orderId },
      { $set: { credited: true, flag: "credit_unconfirmed" } },
    );
    console.error(
      `[Payments] ledger row already exists for order=${order.orderId}: marked credited, needs a human check`,
    );
    return "unconfirmed";
  }

  try {
    await User.updateOne(
      { _id: order.owner },
      { $inc: { credits: order.credits } },
    );
  } catch (err) {
    // The credits did not move, so take the row back: the reconciler can then retry
    await CreditTransaction.deleteOne({ key }).catch(() => undefined);
    throw err;
  }

  await PaymentOrder.updateOne(
    { orderId: order.orderId },
    { $set: { credited: true } },
  );
  return "credited";
}

// Claims the order (pending|challenge -> paid) and adds the credits, once.
async function creditOrder(
  order: IPaymentOrder,
  meta: StatusMeta,
  now: Date,
): Promise<"credited" | "stale"> {
  return runAtomically(async (session): Promise<"credited" | "stale"> => {
    const claimed = await PaymentOrder.findOneAndUpdate(
      {
        orderId: order.orderId,
        credited: false,
        status: { $in: [...ALLOWED_FROM.paid] },
      },
      {
        // in a transaction the order is credited together with this update;
        // without one, finishCredit sets the flag at the end
        $set: {
          ...meta,
          status: "paid",
          paidAt: now,
          credited: session !== null,
        },
      },
      { returnDocument: "after", ...opts(session) },
    );
    // nothing matched: a duplicate notification, a poll that lost the race,
    // or an order that is no longer pending
    if (!claimed) return "stale";

    if (!session) {
      await finishCredit(claimed);
      return "credited";
    }

    const user = await User.findOneAndUpdate(
      { _id: claimed.owner },
      { $inc: { credits: claimed.credits } },
      { returnDocument: "after", projection: { credits: 1 }, session },
    );
    // throwing aborts the transaction, so the order stays pending
    if (!user) {
      throw new Error(
        `user ${String(claimed.owner)} not found while crediting ${claimed.orderId}`,
      );
    }
    await CreditTransaction.create(
      [
        {
          user: claimed.owner,
          type: "purchase",
          amount: claimed.credits,
          balanceAfter: user.credits,
          refKind: REF_KIND,
          refId: claimed.orderId,
          key: purchaseKey(claimed.orderId),
        },
      ],
      { session },
    );
    return "credited";
  });
}

// ── Refund / chargeback (PRD 7.4) ───────────────────────────────────────────

// Takes up to `remaining` credits, never more than the balance (never below 0). The
// balance can change between the read and the update (the user is generating a site),
// so a failed `credits >= n` filter just reads again.
async function takeCredits(
  owner: IPaymentOrder["owner"],
  remaining: number,
  session: ClientSession | null,
): Promise<{ taken: number; balanceAfter: number }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await User.findById(owner)
      .select("credits")
      .session(session)
      .lean();
    const n = Math.min(current?.credits ?? 0, remaining);
    if (n <= 0) return { taken: 0, balanceAfter: current?.credits ?? 0 };

    const updated = await User.findOneAndUpdate(
      { _id: owner, credits: { $gte: n } },
      { $inc: { credits: -n } },
      { returnDocument: "after", projection: { credits: 1 }, ...opts(session) },
    );
    if (updated) return { taken: n, balanceAfter: updated.credits };
  }
  return { taken: 0, balanceAfter: 0 };
}

async function refundOrder(
  order: IPaymentOrder,
  to: "refunded" | "chargeback",
  meta: StatusMeta,
  now: Date,
): Promise<"applied" | "stale"> {
  return runAtomically(async (session): Promise<"applied" | "stale"> => {
    // paid -> refunded | chargeback. Only the request that wins this update runs the
    // clawback, so it happens once even if Midtrans repeats the notification.
    const claimed = await PaymentOrder.findOneAndUpdate(
      { orderId: order.orderId, status: { $in: [...ALLOWED_FROM[to]] } },
      { $set: { ...meta, status: to, clawbackAt: now } },
      { returnDocument: "after", ...opts(session) },
    );
    if (!claimed) return "stale";

    // credits that were never added cannot be taken back
    const remaining = claimed.credited
      ? Math.max(0, claimed.credits - claimed.clawedBack)
      : 0;
    const { taken, balanceAfter } =
      remaining > 0
        ? await takeCredits(claimed.owner, remaining, session)
        : { taken: 0, balanceAfter: 0 };
    const shortfall = remaining - taken;

    await PaymentOrder.updateOne(
      { _id: claimed._id },
      {
        $set: {
          clawedBack: claimed.clawedBack + taken,
          clawbackShortfall: shortfall,
        },
      },
      { ...opts(session) },
    );

    if (taken > 0) {
      await CreditTransaction.create(
        [
          {
            user: claimed.owner,
            type: "purchase_clawback",
            amount: -taken,
            balanceAfter,
            refKind: REF_KIND,
            refId: claimed.orderId,
            key: clawbackKey(claimed.orderId),
          },
        ],
        { ...opts(session) },
      );
    }

    console.log(
      `[Payments] ${to} order=${claimed.orderId} took back ${taken}/${remaining} credits`,
    );
    if (shortfall > 0) {
      console.error(
        `[Payments] CLAWBACK SHORTFALL order=${claimed.orderId} user=${String(claimed.owner)} short=${shortfall}`,
      );
    }
    return "applied";
  });
}

// ── applyMidtransStatus (PRD 7.2 steps 6-8, 7.5) ────────────────────────────

export interface ApplyResult {
  // applied: the order changed | stale: duplicate or out of order, nothing to do
  // ignored: Midtrans said nothing that changes the order | flagged: needs a human look
  outcome: "applied" | "stale" | "ignored" | "flagged";
  to?: PaymentStatus;
}

// `status` MUST come from the Get Status API, never from the notification body.
export async function applyMidtransStatus(
  order: IPaymentOrder,
  status: MidtransStatus,
  now: Date = new Date(),
): Promise<ApplyResult> {
  if (status.order_id !== order.orderId) {
    console.error(
      `[Payments] status is for another order: asked=${order.orderId} got=${status.order_id.slice(0, 60)}`,
    );
    return { outcome: "ignored" };
  }

  // Same amount check as on the notification, now on the confirmed answer
  const gross = parseIdr(status.gross_amount);
  if (gross === null || gross !== order.amount) {
    await PaymentOrder.updateOne(
      { orderId: order.orderId },
      { $set: { flag: "amount_mismatch" } },
    );
    console.error(
      `[Payments] amount mismatch order=${order.orderId} expected=${order.amount} got=${status.gross_amount.slice(0, 32)}`,
    );
    return { outcome: "flagged" };
  }

  const decision = mapMidtransStatus(status);
  const meta = buildMeta(status);

  if (decision.kind === "none") {
    if (decision.warn) {
      console.warn(`[Payments] order=${order.orderId} ${decision.warn}`);
    }
    // Remember the payment method etc., but only while the order is still open
    await PaymentOrder.updateOne(
      { orderId: order.orderId, status: { $in: ["pending", "challenge"] } },
      { $set: meta },
    );
    return { outcome: "ignored" };
  }

  const to = decision.to;

  if (to === "paid") {
    // Do not take the money side of a deleted account: leave it for a human
    if (!(await User.exists({ _id: order.owner }))) {
      await PaymentOrder.updateOne(
        { orderId: order.orderId },
        { $set: { flag: "user_missing" } },
      );
      console.error(
        `[Payments] paid order=${order.orderId} but the user no longer exists`,
      );
      return { outcome: "flagged", to };
    }
    const result = await creditOrder(order, meta, now);
    if (result === "credited") {
      console.log(
        `[Payments] credited order=${order.orderId} +${order.credits}`,
      );
    }
    return { outcome: result === "credited" ? "applied" : "stale", to };
  }

  if (to === "refunded" || to === "chargeback") {
    const result = await refundOrder(order, to, meta, now);
    return { outcome: result, to };
  }

  // challenge | failed | expired | canceled
  const moved = await PaymentOrder.findOneAndUpdate(
    { orderId: order.orderId, status: { $in: [...ALLOWED_FROM[to]] } },
    { $set: { ...meta, status: to } },
    { returnDocument: "after" },
  );
  if (moved) console.log(`[Payments] order=${order.orderId} -> ${to}`);
  return { outcome: moved ? "applied" : "stale", to };
}

// ── Reconciliation (PRD 7.5) ────────────────────────────────────────────────

// Asks Midtrans about an order and applies the answer. Throws when the status API
// cannot be reached; the caller decides what that means (poll: ignore, webhook: 503).
export async function reconcileOrder(
  order: IPaymentOrder,
  gateway: PaymentGateway,
  now: Date = new Date(),
): Promise<ApplyResult> {
  let status: MidtransStatus;
  try {
    status = await gateway.getTransactionStatus(order.orderId);
  } catch (err) {
    if (!(err instanceof TransactionNotFoundError)) throw err;

    // Midtrans knows nothing about it: the customer never picked a payment method.
    // Fine while the order is open; once it is past expiresAt it is over.
    if (order.expiresAt.getTime() > now.getTime())
      return { outcome: "ignored" };

    const expired = await PaymentOrder.findOneAndUpdate(
      { orderId: order.orderId, status: { $in: [...ALLOWED_FROM.expired] } },
      { $set: { status: "expired" } },
      { returnDocument: "after" },
    );
    if (expired)
      console.log(
        `[Payments] order=${order.orderId} -> expired (unknown to Midtrans)`,
      );
    return { outcome: expired ? "applied" : "stale", to: "expired" };
  }
  return applyMidtransStatus(order, status, now);
}
