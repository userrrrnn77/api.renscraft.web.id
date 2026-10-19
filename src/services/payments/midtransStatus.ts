// src/services/payments/midtransStatus.ts

// Pure helpers for Midtrans payloads: no database, no network, so they are easy to test.
//   - signature check of the HTTP notification (PRD 7.2 step 2)
//   - gross_amount parsing (PRD 7.2 step 4)
//   - the status mapping table (PRD 7.2 step 6)
//   - the allowed order transitions (PRD 5.1)
import { createHash, timingSafeEqual } from "node:crypto";
import type {
  ILastMidtransStatus,
  PaymentStatus,
} from "../../models/PaymentOrder.js";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;

// ── Payloads ────────────────────────────────────────────────────────────────

// The four fields every HTTP notification carries (extra fields are ignored).
export interface MidtransNotification {
  order_id: string;
  status_code: string;
  gross_amount: string;
  signature_key: string;
}

// What the Get Status API says about a transaction (only the fields we use).
export interface MidtransStatus {
  order_id: string;
  status_code: string;
  gross_amount: string;
  transaction_status: string;
  fraud_status?: string | undefined;
  payment_type?: string | undefined;
  transaction_id?: string | undefined;
  settlement_time?: string | undefined;
}

// null = not a usable notification (answer 400)
export function parseNotification(body: unknown): MidtransNotification | null {
  if (!isRecord(body)) return null;
  const order_id = text(body.order_id, 100);
  const status_code = text(body.status_code, 10);
  const gross_amount = text(body.gross_amount, 32);
  const signature_key = text(body.signature_key, 256);
  if (!order_id || !status_code || !gross_amount || !signature_key) return null;
  return { order_id, status_code, gross_amount, signature_key };
}

// null = the Get Status API answered with something we cannot use
export function parseStatusResponse(body: unknown): MidtransStatus | null {
  if (!isRecord(body)) return null;
  const order_id = text(body.order_id, 100);
  const status_code = text(body.status_code, 10);
  const gross_amount = text(body.gross_amount, 32);
  const transaction_status = text(body.transaction_status, 32);
  if (!order_id || !status_code || !gross_amount || !transaction_status) {
    return null;
  }
  return {
    order_id,
    status_code,
    gross_amount,
    transaction_status,
    fraud_status: text(body.fraud_status, 32),
    payment_type: text(body.payment_type, 64),
    transaction_id: text(body.transaction_id, 100),
    settlement_time: text(body.settlement_time, 64),
  };
}

// Midtrans can answer "not found" as HTTP 404 or as HTTP 200 with status_code "404"
export const readStatusCode = (body: unknown): string | undefined =>
  isRecord(body) ? text(body.status_code, 10) : undefined;

// What is stored on the order: no signature, no card data (PRD 5.1)
export function trimStatus(status: MidtransStatus): ILastMidtransStatus {
  return {
    transaction_status: status.transaction_status,
    status_code: status.status_code,
    ...(status.fraud_status ? { fraud_status: status.fraud_status } : {}),
    ...(status.payment_type ? { payment_type: status.payment_type } : {}),
    ...(status.settlement_time
      ? { settlement_time: status.settlement_time }
      : {}),
  };
}

// ── Signature ───────────────────────────────────────────────────────────────

// SHA512(order_id + status_code + gross_amount + serverKey), hex. gross_amount is
// used exactly as received ("15000.00"), never re-formatted.
export function isValidSignature(
  n: MidtransNotification,
  serverKey: string,
): boolean {
  const expected = Buffer.from(
    createHash("sha512")
      .update(n.order_id + n.status_code + n.gross_amount + serverKey)
      .digest("hex"),
    "utf8",
  );
  const given = Buffer.from(n.signature_key, "utf8");
  // timingSafeEqual throws on different lengths, so compare the BYTE lengths first
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

// ── Amount ──────────────────────────────────────────────────────────────────

// "100000.00" -> 100000, "100000" -> 100000, "100.50" / garbage -> null
export function parseIdr(gross: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(gross)) return null;
  const value = Number(gross);
  return Number.isSafeInteger(value) ? value : null;
}

// ── Status mapping ──────────────────────────────────────────────────────────

export type StatusDecision =
  // keep the order as it is (`warn` = log it, Midtrans said something unexpected)
  { kind: "none"; warn?: string } | { kind: "transition"; to: PaymentStatus };

export function mapMidtransStatus(s: MidtransStatus): StatusDecision {
  const fraud = s.fraud_status;

  switch (s.transaction_status) {
    case "settlement":
      if (s.status_code === "200" && (!fraud || fraud === "accept")) {
        return { kind: "transition", to: "paid" };
      }
      return {
        kind: "none",
        warn: `settlement with status_code=${s.status_code} fraud_status=${fraud ?? "-"}`,
      };

    case "capture":
      if (s.status_code === "200" && fraud === "accept") {
        return { kind: "transition", to: "paid" };
      }
      if (fraud === "challenge") return { kind: "transition", to: "challenge" };
      return {
        kind: "none",
        warn: `capture with status_code=${s.status_code} fraud_status=${fraud ?? "-"}`,
      };

    case "pending":
      return { kind: "none" };

    case "deny":
    case "failure":
      return { kind: "transition", to: "failed" };

    case "cancel":
      return { kind: "transition", to: "canceled" };

    case "expire":
      return { kind: "transition", to: "expired" };

    case "refund":
    case "partial_refund":
      return { kind: "transition", to: "refunded" };

    case "chargeback":
    case "partial_chargeback":
      return { kind: "transition", to: "chargeback" };

    default:
      return {
        kind: "none",
        warn: `unknown transaction_status "${s.transaction_status.slice(0, 32)}"`,
      };
  }
}

// ── Transitions ─────────────────────────────────────────────────────────────

// target status -> the statuses it may be reached from. This goes straight into the
// filter of the atomic update, so a late expire / cancel / pending can never change
// a paid order (PRD 5.1).
export const ALLOWED_FROM: Readonly<
  Record<PaymentStatus, readonly PaymentStatus[]>
> = {
  pending: [],
  challenge: ["pending"],
  paid: ["pending", "challenge"],
  failed: ["pending", "challenge"],
  expired: ["pending", "challenge"],
  canceled: ["pending", "challenge"],
  refunded: ["paid"],
  chargeback: ["paid"],

  // Status khusus untuk manual transfer (nggak lewat Midtrans)
  pending_manual: [],
  ocr_pending: [],
  waiting_approval: [],
  manual_review: [],
  manual_rejected: [],
};

export const canTransition = (
  from: PaymentStatus,
  to: PaymentStatus,
): boolean => ALLOWED_FROM[to].includes(from);
