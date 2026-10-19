// src/services/abuseGuard.ts

import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { Request } from "express";
import { IpSignupBucket } from "../models/IpSignupBucket.js";

// Free credits are limited per IP, not per email: a new email is free to make,
// a new IP is not. We never block the signup itself (many Indonesian mobile
// users share one carrier-grade NAT address), we only withhold the free credits
// once an IP has used up its quota.
//
//   FREE_SIGNUP_CREDITS=15        credits for a new account
//                                  (1 website + 1 revision: enough to try,
//                                   not enough to skip paying)
//   MAX_FREE_SIGNUPS_PER_IP=3     accounts per IP that still get them
//   FREE_SIGNUP_WINDOW_DAYS=30    window of that quota
//   IP_HASH_SECRET=...            required in production (HMAC key)
//   TRUST_CLOUDFLARE=true         read the IP from CF-Connecting-IP (see getClientIp)

const DAY_MS = 86_400_000;

const intEnv = (name: string, fallback: number): number => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const signupConfig = () => ({
  credits: intEnv("FREE_SIGNUP_CREDITS", 15),
  maxPerIp: intEnv("MAX_FREE_SIGNUPS_PER_IP", 3),
  windowDays: intEnv("FREE_SIGNUP_WINDOW_DAYS", 30),
});

// Expand an IPv6 address and keep only the first 4 groups (the /64). Anyone
// with IPv6 owns a whole /64, so a single address would be trivial to rotate.
function ipv6Prefix64(ip: string): string {
  const [head = "", tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [
        ...h,
        ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"),
        ...t,
      ]
    : h;
  return groups
    .slice(0, 4)
    .map((g) => g.padStart(4, "0").toLowerCase())
    .join(":");
}

export function normalizeIp(raw: string): string {
  const ip = (raw.trim().split("%")[0] ?? "").trim();
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) is the same client as 1.2.3.4
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (isIP(ip) === 6 && !ip.includes(".")) return `${ipv6Prefix64(ip)}::/64`;
  return ip;
}

const hmacSecret = (): string => {
  const secret = process.env.IP_HASH_SECRET;
  if (secret) return secret;
  // No silent fallback in production: a known key makes the hashes reversible
  // (the IPv4 space is small enough to brute-force).
  if (process.env.NODE_ENV === "production") {
    throw new Error("IP_HASH_SECRET must be set in production");
  }
  return "dev-only-ip-hash-secret";
};

export const hashIp = (ip: string): string =>
  createHmac("sha256", hmacSecret()).update(normalizeIp(ip)).digest("hex");

// Behind Cloudflare the TCP peer is Cloudflare, the real client is in the
// CF-Connecting-IP header. That header is only trustworthy when the server
// accepts traffic from Cloudflare ONLY (firewall / security list); otherwise
// anyone can fake it. Without Cloudflare, set TRUST_PROXY_HOPS in server.js so
// Express reads X-Forwarded-For and `req.ip` is the real client.
export function getClientIp(req: Request): string | null {
  if (process.env.TRUST_CLOUDFLARE === "true") {
    const cf = req.headers["cf-connecting-ip"];
    const value = typeof cf === "string" ? cf.trim() : "";
    if (isIP(value)) return value;
  }
  return req.ip ?? req.socket.remoteAddress ?? null;
}

export type SignupGrant = {
  credits: number;
  ipHash: string | null;
  reason: "ok" | "ip_limit" | "no_ip";
};

// Decide how many free credits this signup gets. The counter is a single atomic
// upsert + $inc, so parallel signups from one IP cannot all slip under the limit.
export async function evaluateFreeSignup(req: Request): Promise<SignupGrant> {
  const { credits, maxPerIp, windowDays } = signupConfig();

  const ip = getClientIp(req);
  if (!ip) return { credits: 0, ipHash: null, reason: "no_ip" };

  const ipHash = hashIp(ip);
  const bucket = await IpSignupBucket.findOneAndUpdate(
    { ipHash },
    {
      $inc: { count: 1 },
      $setOnInsert: { expiresAt: new Date(Date.now() + windowDays * DAY_MS) },
    },
    { upsert: true, returnDocument: "after" },
  );

  const allowed = (bucket?.count ?? Number.POSITIVE_INFINITY) <= maxPerIp;
  return {
    credits: allowed ? credits : 0,
    ipHash,
    reason: allowed ? "ok" : "ip_limit",
  };
}
