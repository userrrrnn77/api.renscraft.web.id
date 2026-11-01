// status-worker/src/config.ts

export interface Env {
  DB: D1Database;
  MAINTENANCE_TOKEN: string;
  WEBSITE_URL: string;
  API_HEALTH_URL: string;
  PUBLISHED_PROBE_URL: string;
  ALLOWED_ORIGINS: string;
  TZ_OFFSET_MINUTES: string;
}

export const DAYS = 30;
export const FAIL_THRESHOLD = 2;
export const TIMEOUT_MS = 8000;
export const STALE_AFTER_MS = 5 * 60 * 1000;

export const DEGRADED_MS = {
  website: 3000,
  api: 2000,
  published: 3000,
} as const;

export const SERVICE_ORDER = [
  "website",
  "api",
  "database",
  "published",
] as const;
export type ServiceId = (typeof SERVICE_ORDER)[number];

export type RawStatus = "operational" | "degraded" | "down";
export type FinalStatus = "operational" | "degraded" | "outage";
export type DayStatus = "operational" | "degraded" | "outage" | "nodata";
