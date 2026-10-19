// src/services/payments/midtransGateway.ts

// The only file that talks to Midtrans over the network (PRD 7.1). Everything else in
// payments depends on the PaymentGateway interface, so it can be tested with a fake.
//
// Plain fetch instead of midtrans-client: the SDK has no request timeout and hides the
// "HTTP 200 with status_code 404" answer of the status API, which reconcileOrder needs
// (TransactionNotFoundError).
//
// The keys are read from getMidtransConfig() on EVERY call, never when the gateway is
// created. paymentRoutes.ts builds the default gateway at import time, and with
// PAYMENTS_ENABLED=false the Midtrans variables do not have to exist.
// Nothing here ever logs or throws a key.
import { getMidtransConfig } from "../../config/env.js";
import {
  isRecord,
  parseStatusResponse,
  readStatusCode,
} from "./midtransStatus.js";
import type { MidtransStatus } from "./midtransStatus.js";

// ── Public types ────────────────────────────────────────────────────────────

export interface SnapInput {
  orderId: string;
  // IDR, integer
  amount: number;
  packageId: string;
  itemName: string;
  customer: { firstName: string; email: string };
  expiryMinutes: number;
  // optional Snap callbacks.finish URL (PUBLIC_APP_URL)
  finishUrl?: string;
}

export interface PaymentGateway {
  createSnapTransaction(
    input: SnapInput,
  ): Promise<{ token: string; redirectUrl: string }>;
  // GET status API. Throws TransactionNotFoundError when Midtrans does not know the order.
  getTransactionStatus(orderId: string): Promise<MidtransStatus>;
}

// Midtrans has no record of the order: the customer never picked a payment method.
export class TransactionNotFoundError extends Error {
  constructor(orderId: string) {
    super(`Midtrans has no transaction for order ${orderId.slice(0, 60)}`);
    this.name = "TransactionNotFoundError";
  }
}

// ── Environment ─────────────────────────────────────────────────────────────

const hostsFor = (isProduction: boolean) =>
  isProduction
    ? {
        snap: "https://app.midtrans.com",
        api: "https://api.midtrans.com",
      }
    : {
        snap: "https://app.sandbox.midtrans.com",
        api: "https://api.sandbox.midtrans.com",
      };

// snap.js for the client (sent to the browser by GET /api/payments/config)
export const snapJsUrl = (isProduction: boolean): string =>
  `${hostsFor(isProduction).snap}/snap/snap.js`;

// ── Implementation ──────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 10_000;

type FetchFn = typeof fetch;

export interface GatewayDeps {
  fetchFn?: FetchFn;
  getConfig?: () => { serverKey: string; isProduction: boolean };
  timeoutMs?: number;
}

const basicAuth = (serverKey: string): string =>
  `Basic ${Buffer.from(`${serverKey}:`).toString("base64")}`;

// Midtrans error bodies are short: error_messages (Snap) or status_message (Core API)
function describeError(body: unknown): string {
  if (!isRecord(body)) return "no details";
  const messages = body.error_messages;
  if (Array.isArray(messages)) {
    const text = messages
      .filter((m): m is string => typeof m === "string")
      .join("; ");
    if (text) return text.slice(0, 300);
  }
  if (typeof body.status_message === "string") {
    return body.status_message.slice(0, 300);
  }
  return "no details";
}

async function request(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const res = await fetchFn(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    // not JSON (an HTML error page from a proxy, for example)
  }
  return { status: res.status, body };
}

export function createMidtransGateway(deps: GatewayDeps = {}): PaymentGateway {
  const fetchFn = deps.fetchFn ?? fetch;
  const getConfig = deps.getConfig ?? getMidtransConfig;
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;

  return {
    async createSnapTransaction(input) {
      if (!Number.isInteger(input.amount) || input.amount <= 0) {
        throw new Error(`Invalid amount for order ${input.orderId}`);
      }
      const { serverKey, isProduction } = getConfig();

      const payload = {
        transaction_details: {
          order_id: input.orderId,
          gross_amount: input.amount,
        },
        item_details: [
          {
            id: input.packageId,
            price: input.amount,
            quantity: 1,
            // Midtrans caps the item name at 50 characters
            name: input.itemName.slice(0, 50),
          },
        ],
        customer_details: {
          first_name: input.customer.firstName.slice(0, 255),
          email: input.customer.email,
        },
        expiry: { unit: "minutes", duration: input.expiryMinutes },
        ...(input.finishUrl ? { callbacks: { finish: input.finishUrl } } : {}),
      };

      const { status, body } = await request(
        fetchFn,
        `${hostsFor(isProduction).snap}/snap/v1/transactions`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: basicAuth(serverKey),
          },
          body: JSON.stringify(payload),
        },
        timeoutMs,
      );

      if (status < 200 || status >= 300) {
        throw new Error(`Midtrans Snap HTTP ${status}: ${describeError(body)}`);
      }
      if (
        !isRecord(body) ||
        typeof body.token !== "string" ||
        typeof body.redirect_url !== "string"
      ) {
        throw new Error("Midtrans Snap answered without token / redirect_url");
      }
      return { token: body.token, redirectUrl: body.redirect_url };
    },

    async getTransactionStatus(orderId) {
      const { serverKey, isProduction } = getConfig();

      const { status, body } = await request(
        fetchFn,
        `${hostsFor(isProduction).api}/v2/${encodeURIComponent(orderId)}/status`,
        {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: basicAuth(serverKey),
          },
        },
        timeoutMs,
      );

      // "not found" comes as HTTP 404 or as HTTP 200 with status_code "404" in the body
      if (status === 404 || readStatusCode(body) === "404") {
        throw new TransactionNotFoundError(orderId);
      }
      if (status < 200 || status >= 300) {
        throw new Error(
          `Midtrans status HTTP ${status}: ${describeError(body)}`,
        );
      }

      const parsed = parseStatusResponse(body);
      if (!parsed) {
        throw new Error(
          `Midtrans status for ${orderId.slice(0, 60)} has an unexpected shape (status_code=${readStatusCode(body) ?? "-"})`,
        );
      }
      return parsed;
    },
  };
}
