// src/utils/orderId.ts

import { randomBytes } from "node:crypto";

// RSC-<yyMMdd>-<12 random url-safe chars>. 23 characters (Midtrans allows 50).
// 9 random bytes = 72 bits, so an order id cannot be guessed from another one.
// NOTE: legacy orders created before the Renscraft rebrand still start with BAI-,
// so the regex accepts both. generateOrderId() only ever emits RSC- now.
export const ORDER_ID_RE = /^(?:RSC|BAI)-\d{6}-[A-Za-z0-9_-]{6,12}$/;

const two = (n: number): string => String(n).padStart(2, "0");

export function yyMMdd(date: Date): string {
  return `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}`;
}

export function generateOrderId(now: Date = new Date()): string {
  return `RSC-${yyMMdd(now)}-${randomBytes(9).toString("base64url")}`;
}
