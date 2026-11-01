// status-worker/src/checks.ts
import { DEGRADED_MS, TIMEOUT_MS, type RawStatus } from "./config.js";
import { fetchWithTimeout } from "./utils.js";

export interface ProbeResult {
  raw: RawStatus;
  latency_ms: number;
  db_raw?: RawStatus;
}

const classifyLatency = (latency: number, degradedMs: number): RawStatus =>
  latency > degradedMs ? "degraded" : "operational";

export const probeWebsite = async (url: string): Promise<ProbeResult> => {
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(url, TIMEOUT_MS);
    await res.text().catch(() => "");
    const latency = Date.now() - start;
    if (res.status >= 200 && res.status < 300) {
      return {
        raw: classifyLatency(latency, DEGRADED_MS.website),
        latency_ms: latency,
      };
    }
    return { raw: "down", latency_ms: latency };
  } catch {
    return { raw: "down", latency_ms: Date.now() - start };
  }
};

export const probeApi = async (url: string): Promise<ProbeResult> => {
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(url, TIMEOUT_MS);
    const latency = Date.now() - start;
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      return { raw: "down", db_raw: "down", latency_ms: latency };
    }
    const b = body as { status?: string; db?: string } | null;
    if (res.status === 200 && b?.status === "ok" && b?.db === "up") {
      return {
        raw: classifyLatency(latency, DEGRADED_MS.api),
        db_raw: "operational",
        latency_ms: latency,
      };
    }
    if (res.status === 503 && b?.db === "down") {
      return { raw: "degraded", db_raw: "down", latency_ms: latency };
    }
    return { raw: "down", db_raw: "down", latency_ms: latency };
  } catch {
    return { raw: "down", db_raw: "down", latency_ms: Date.now() - start };
  }
};

export const probePublished = async (url: string): Promise<ProbeResult> => {
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(url, TIMEOUT_MS);
    await res.text().catch(() => "");
    const latency = Date.now() - start;
    if (res.status >= 200 && res.status < 300) {
      return {
        raw: classifyLatency(latency, DEGRADED_MS.published),
        latency_ms: latency,
      };
    }
    return { raw: "down", latency_ms: latency };
  } catch {
    return { raw: "down", latency_ms: Date.now() - start };
  }
};
