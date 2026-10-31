import type { NextFunction, Request, Response } from "express";
import { fail } from "../utils/apiError.js";

type Bucket = { count: number; reset: number };

const ipCache = new Map<string, Bucket>();
const appCache = new Map<string, Bucket>();

const WINDOW_MS = 60_000;

const intEnv = (name: string, fallback: number): number => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// create: PRD default 10/IP, 60/app.
// read: dibuat lebih longgar, bisa dioverride lewat env.
const limits = () => ({
  create: {
    perIp: intEnv("DYNAMIC_RUNTIME_RATE_PER_IP", 10),
    perApp: intEnv("DYNAMIC_RUNTIME_RATE_PER_APP", 60),
  },
  read: {
    perIp: intEnv("DYNAMIC_RUNTIME_RATE_READ_PER_IP", 60),
    perApp: intEnv("DYNAMIC_RUNTIME_RATE_READ_PER_APP", 600),
  },
});

const slugFromPath = (path: string): string => {
  // path di dalam router = /<slug>/collections/<name>/documents...
  const first = (path.split("?")[0] ?? "").split("/").filter(Boolean)[0];
  if (!first) return "unknown";
  try {
    return decodeURIComponent(first);
  } catch {
    return first;
  }
};

const bump = (
  map: Map<string, Bucket>,
  key: string,
  limit: number,
  now: number,
): boolean => {
  let rec = map.get(key);
  if (!rec || rec.reset <= now) {
    rec = { count: 1, reset: now + WINDOW_MS };
    map.set(key, rec);
  } else {
    rec.count += 1;
  }
  return rec.count <= limit;
};

const cleanup = (map: Map<string, Bucket>, now: number): void => {
  for (const [k, v] of map) {
    if (v.reset <= now) map.delete(k);
  }
};

const sweeper = setInterval(() => {
  const now = Date.now();
  cleanup(ipCache, now);
  cleanup(appCache, now);
}, WINDOW_MS);
sweeper.unref?.();

export function dynamicRuntimeRateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const now = Date.now();
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const slug = slugFromPath(req.path);
  const action = req.method === "POST" ? "create" : "read";
  const cfg = limits()[action];

  if (!bump(ipCache, `${action}|${ip}`, cfg.perIp, now)) {
    return fail(
      res,
      429,
      "RUNTIME_RATE_LIMITED",
      {},
      "Too many requests from this IP",
    );
  }

  if (!bump(appCache, `${action}|${slug}`, cfg.perApp, now)) {
    return fail(
      res,
      429,
      "RUNTIME_RATE_LIMITED",
      {},
      "Too many requests for this app",
    );
  }

  next();
}
