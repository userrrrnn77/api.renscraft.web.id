// status-worker/src/state.ts
import {
  FAIL_THRESHOLD,
  type FinalStatus,
  type RawStatus,
  type ServiceId,
} from "./config.js";
import { dayKey } from "./utils.js";

export interface ProbeEntry {
  raw: RawStatus;
  latency_ms: number;
}

interface CurrentStateRow {
  service: string;
  status: FinalStatus;
  consecutive_fail: number;
  fail_since: number | null;
  last_checked_at: number;
  last_latency_ms: number | null;
  since: number;
}

export interface StateOutcome {
  service: ServiceId;
  status: FinalStatus;
  consecutive_fail: number;
  fail_since: number | null;
  changed: boolean;
}

const runStateMachine = (
  service: ServiceId,
  raw: RawStatus,
  prev: CurrentStateRow | null,
  now: number,
): StateOutcome => {
  let status: FinalStatus;
  let consecutive_fail: number;
  let fail_since: number | null;

  if (raw === "operational") {
    status = "operational";
    consecutive_fail = 0;
    fail_since = null;
  } else if (raw === "degraded") {
    status = "degraded";
    consecutive_fail = 0;
    fail_since = null;
  } else {
    consecutive_fail = (prev?.consecutive_fail ?? 0) + 1;
    fail_since =
      (prev?.consecutive_fail ?? 0) > 0 ? (prev?.fail_since ?? now) : now;
    status =
      consecutive_fail >= FAIL_THRESHOLD
        ? "outage"
        : (prev?.status ?? "operational");
  }

  const changed = prev?.status !== status;
  return { service, status, consecutive_fail, fail_since, changed };
};

export const applyProbes = async (
  env: { DB: D1Database; TZ_OFFSET_MINUTES: string },
  probes: Partial<Record<ServiceId, ProbeEntry>>,
  now: number,
): Promise<void> => {
  const tzOffset = parseInt(env.TZ_OFFSET_MINUTES, 10) || 420;
  const day = dayKey(now, tzOffset);
  const activeServices = (Object.keys(probes) as ServiceId[]).filter(
    (s) => probes[s] != null,
  );
  if (activeServices.length === 0) return;

  const placeholders = activeServices.map(() => "?").join(",");
  const stateQuery = await env.DB.prepare(
    `SELECT * FROM current_state WHERE service IN (${placeholders})`,
  )
    .bind(...activeServices)
    .all<CurrentStateRow>();

  const prevMap = new Map<string, CurrentStateRow>();
  for (const row of stateQuery.results ?? []) prevMap.set(row.service, row);

  const statements: D1PreparedStatement[] = [];

  for (const service of activeServices) {
    const probe = probes[service]!;
    const prev = prevMap.get(service) ?? null;
    const outcome = runStateMachine(service, probe.raw, prev, now);
    const since = prev?.status === outcome.status ? prev.since : now;

    statements.push(
      env.DB.prepare(
        `INSERT INTO current_state
           (service, status, consecutive_fail, fail_since, last_checked_at, last_latency_ms, since)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(service) DO UPDATE SET
           status = excluded.status,
           consecutive_fail = excluded.consecutive_fail,
           fail_since = excluded.fail_since,
           last_checked_at = excluded.last_checked_at,
           last_latency_ms = excluded.last_latency_ms,
           since = excluded.since`,
      ).bind(
        service,
        outcome.status,
        outcome.consecutive_fail,
        outcome.fail_since,
        now,
        probe.latency_ms,
        since,
      ),
    );

    const ok = probe.raw === "operational" ? 1 : 0;
    const deg = probe.raw === "degraded" ? 1 : 0;
    const down = probe.raw === "down" ? 1 : 0;
    statements.push(
      env.DB.prepare(
        `INSERT INTO daily (service, day, total, ok, degraded, down)
         VALUES (?1, ?2, 1, ?3, ?4, ?5)
         ON CONFLICT(service, day) DO UPDATE SET
           total    = total    + 1,
           ok       = ok       + excluded.ok,
           degraded = degraded + excluded.degraded,
           down     = down     + excluded.down`,
      ).bind(service, day, ok, deg, down),
    );

    if (outcome.changed) {
      statements.push(
        env.DB.prepare(
          `UPDATE incidents SET resolved_at = ? WHERE service = ? AND resolved_at IS NULL`,
        ).bind(now, service),
      );
      if (outcome.status !== "operational") {
        const startedAt =
          outcome.status === "outage" ? (outcome.fail_since ?? now) : now;
        statements.push(
          env.DB.prepare(
            `INSERT INTO incidents (service, status, started_at) VALUES (?, ?, ?)`,
          ).bind(service, outcome.status, startedAt),
        );
      }
    }
  }

  await env.DB.batch(statements);
};

export const pruneOldData = async (
  env: { DB: D1Database },
  now: number,
): Promise<void> => {
  const dayMs = 24 * 60 * 60 * 1000;
  const cutoffDaily = new Date(now - 400 * dayMs).toISOString().slice(0, 10);
  const cutoffIncidents = now - 120 * dayMs;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM daily WHERE day < ?`).bind(cutoffDaily),
    env.DB.prepare(
      `DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?`,
    ).bind(cutoffIncidents),
  ]);
};
