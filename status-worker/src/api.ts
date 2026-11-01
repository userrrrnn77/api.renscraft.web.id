// status-worker/src/api.ts
import {
  DAYS,
  SERVICE_ORDER,
  STALE_AFTER_MS,
  type DayStatus,
  type Env,
  type FinalStatus,
  type ServiceId,
} from "./config.js";
import { dayKey, json } from "./utils.js";
import { getMaintenanceFlag } from "./maintenance.js";

interface CurrentStateRow {
  service: string;
  status: FinalStatus;
  last_checked_at: number;
  last_latency_ms: number | null;
}

interface DailyRow {
  service: string;
  day: string;
  total: number;
  ok: number;
  degraded: number;
  down: number;
}

interface IncidentRow {
  id: number;
  service: string;
  status: "degraded" | "outage";
  started_at: number;
  resolved_at: number | null;
  note: string | null;
}

const classifyDay = (row: DailyRow | undefined): DayStatus => {
  if (!row || row.total === 0) return "nodata";
  const uptime = (row.ok + row.degraded) / row.total;
  if (uptime < 0.95) return "outage";
  if (uptime < 0.995 || row.degraded / row.total >= 0.05) return "degraded";
  return "operational";
};

const dayRange = (now: number, tzOffsetMinutes: number): string[] => {
  const dayMs = 24 * 60 * 60 * 1000;
  const out: string[] = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    out.push(dayKey(now - i * dayMs, tzOffsetMinutes));
  }
  return out;
};

const pickOverall = (
  maintenance: boolean,
  statuses: FinalStatus[],
): "operational" | "degraded" | "outage" | "maintenance" | "unknown" => {
  if (maintenance) return "maintenance";
  if (statuses.length === 0) return "unknown";
  if (statuses.includes("outage")) return "outage";
  if (statuses.includes("degraded")) return "degraded";
  return "operational";
};

const buildFreshResponse = async (env: Env): Promise<Response> => {
  const now = Date.now();
  const tzOffset = parseInt(env.TZ_OFFSET_MINUTES, 10) || 420;
  const days = dayRange(now, tzOffset);
  const oldestDay = days[0]!;

  const [stateRes, dailyRes, incidentsRes, maintenance] = await Promise.all([
    env.DB.prepare(
      `SELECT service, status, last_checked_at, last_latency_ms FROM current_state`,
    ).all<CurrentStateRow>(),
    env.DB.prepare(
      `SELECT service, day, total, ok, degraded, down FROM daily WHERE day >= ?`,
    )
      .bind(oldestDay)
      .all<DailyRow>(),
    env.DB.prepare(
      `SELECT id, service, status, started_at, resolved_at, note
       FROM incidents ORDER BY started_at DESC LIMIT 10`,
    ).all<IncidentRow>(),
    getMaintenanceFlag(env),
  ]);

  const states = stateRes.results ?? [];
  const dailies = dailyRes.results ?? [];
  const incidents = incidentsRes.results ?? [];

  const activeServiceIds: ServiceId[] = SERVICE_ORDER.filter((id) => {
    if (id === "published" && !env.PUBLISHED_PROBE_URL) return false;
    return true;
  });

  const dailyByService = new Map<string, Map<string, DailyRow>>();
  for (const row of dailies) {
    let m = dailyByService.get(row.service);
    if (!m) {
      m = new Map();
      dailyByService.set(row.service, m);
    }
    m.set(row.day, row);
  }

  const stateByService = new Map<string, CurrentStateRow>();
  for (const s of states) stateByService.set(s.service, s);

  let anyData = false;
  const services = activeServiceIds.map((id) => {
    const st = stateByService.get(id) ?? null;
    const dm = dailyByService.get(id) ?? new Map<string, DailyRow>();

    let totalAll = 0;
    let okAll = 0;
    const daysOut = days.map((d) => {
      const row = dm.get(d);
      const dayStatus = classifyDay(row);
      if (row && row.total > 0) {
        anyData = true;
        totalAll += row.total;
        okAll += row.ok + row.degraded;
      }
      const uptime =
        row && row.total > 0
          ? Math.round(((row.ok + row.degraded) / row.total) * 10000) / 100
          : null;
      return {
        date: d,
        status: dayStatus,
        uptime,
        checks: row?.total ?? 0,
      };
    });

    const uptime30 =
      totalAll > 0 ? Math.round((okAll / totalAll) * 10000) / 100 : null;

    const effectiveStatus: FinalStatus | "maintenance" | "unknown" =
      maintenance.active
        ? "maintenance"
        : (st?.status ?? (anyData ? "operational" : "unknown"));

    return {
      id,
      status: effectiveStatus,
      latency_ms: st?.last_latency_ms ?? null,
      last_checked_at: st ? new Date(st.last_checked_at).toISOString() : null,
      uptime_30d: uptime30,
      days: daysOut,
    };
  });

  const serviceStatuses: FinalStatus[] = activeServiceIds
    .map((id) => stateByService.get(id)?.status)
    .filter((s): s is FinalStatus => s != null);

  const oldestCheck = states.reduce<number | null>((acc, s) => {
    if (s.last_checked_at == null) return acc;
    return acc == null || s.last_checked_at < acc ? s.last_checked_at : acc;
  }, null);

  const stale =
    !maintenance.active &&
    oldestCheck != null &&
    Date.now() - oldestCheck > STALE_AFTER_MS;

  const payload = {
    generated_at: new Date().toISOString(),
    overall: pickOverall(maintenance.active, serviceStatuses),
    stale,
    maintenance: {
      active: maintenance.active,
      message: maintenance.active ? maintenance.message : null,
      until:
        maintenance.active && maintenance.until
          ? new Date(maintenance.until).toISOString()
          : null,
    },
    services,
    incidents: incidents.map((i) => ({
      id: i.id,
      service: i.service,
      status: i.status,
      started_at: new Date(i.started_at).toISOString(),
      resolved_at: i.resolved_at ? new Date(i.resolved_at).toISOString() : null,
      note: i.note,
    })),
  };

  return json(payload, {
    status: 200,
    headers: { "Cache-Control": "public, max-age=30" },
  });
};

const applyCors = (headers: Headers, origin: string | null, env: Env) => {
  if (!origin) return;
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  if (allowed.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.append("Vary", "Origin");
  }
};

export const corsPreflight = (request: Request, env: Env): Response => {
  const origin = request.headers.get("Origin");
  const headers = new Headers();
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  applyCors(headers, origin, env);
  return new Response(null, { status: 204, headers });
};

export const buildStatusResponse = async (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> => {
  const cache = caches.default;
  const cacheKey = new Request("https://status-cache.internal/api/status");

  let cached = await cache.match(cacheKey);
  if (!cached) {
    const fresh = await buildFreshResponse(env);
    const toCache = fresh.clone();
    ctx.waitUntil(cache.put(cacheKey, toCache));
    cached = fresh;
  }

  const headers = new Headers(cached.headers);
  applyCors(headers, request.headers.get("Origin"), env);
  return new Response(cached.body, { status: cached.status, headers });
};
