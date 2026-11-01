// status-worker/src/index.ts
import { SERVICE_ORDER, type Env, type ServiceId } from "./config.js";
import {
  probeApi,
  probePublished,
  probeWebsite,
  type ProbeResult,
} from "./checks.js";
import { applyProbes, pruneOldData, type ProbeEntry } from "./state.js";
import { buildStatusResponse, corsPreflight } from "./api.js";
import { getMaintenanceFlag, handleMaintenanceRequest } from "./maintenance.js";
import { json } from "./utils.js";

const runScheduled = async (env: Env): Promise<void> => {
  const flag = await getMaintenanceFlag(env);
  if (flag.active) return;

  const probes: Partial<Record<ServiceId, ProbeEntry>> = {};

  const tasks: Array<Promise<void>> = [];

  tasks.push(
    probeWebsite(env.WEBSITE_URL).then((r: ProbeResult) => {
      probes.website = { raw: r.raw, latency_ms: r.latency_ms };
    }),
  );

  tasks.push(
    probeApi(env.API_HEALTH_URL).then((r: ProbeResult) => {
      probes.api = { raw: r.raw, latency_ms: r.latency_ms };
      probes.database = {
        raw: r.db_raw === "operational" ? "operational" : "down",
        latency_ms: r.latency_ms,
      };
    }),
  );

  if (env.PUBLISHED_PROBE_URL && env.PUBLISHED_PROBE_URL.trim() !== "") {
    tasks.push(
      probePublished(env.PUBLISHED_PROBE_URL).then((r: ProbeResult) => {
        probes.published = { raw: r.raw, latency_ms: r.latency_ms };
      }),
    );
  }

  await Promise.all(tasks);

  const now = Date.now();
  await applyProbes(env, probes, now);

  // Prune sekali sehari jam 03:05 waktu lokal (sesuai TZ_OFFSET_MINUTES)
  const tzOffset = parseInt(env.TZ_OFFSET_MINUTES, 10) || 420;
  const wib = new Date(now + tzOffset * 60000);
  const wibHour = wib.getUTCHours();
  const wibMinute = wib.getUTCMinutes();
  const day = wib.toISOString().slice(0, 10);
  const shouldPrune = wibHour > 3 || (wibHour === 3 && wibMinute >= 5);

  if (shouldPrune) {
    const last = await env.DB.prepare(
      "SELECT value FROM meta WHERE key = 'last_prune_day'",
    ).first<{ value: string }>();
    if (last?.value !== day) {
      await pruneOldData(env, now);
      await env.DB.prepare(
        `INSERT INTO meta (key, value) VALUES ('last_prune_day', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
        .bind(day)
        .run();
    }
  }
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname === "/api/status") {
      return corsPreflight(request, env);
    }

    if (url.pathname === "/api/status" && request.method === "GET") {
      return buildStatusResponse(request, env, ctx);
    }

    if (
      url.pathname === "/api/admin/maintenance" &&
      request.method === "POST"
    ) {
      return handleMaintenanceRequest(request, env);
    }

    return json({ error: "not_found" }, { status: 404 });
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runScheduled(env));
  },
};

export type { Env };
