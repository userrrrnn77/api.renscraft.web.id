// status-worker/src/maintenance.ts
import type { Env } from "./config.js";
import { json, safeEqual } from "./utils.js";

export interface MaintenanceFlag {
  active: boolean;
  message: string | null;
  until: number | null;
}

export const getMaintenanceFlag = async (
  env: Env,
): Promise<MaintenanceFlag> => {
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM meta WHERE key = 'maintenance'",
    ).first<{ value: string }>();
    if (!row) return { active: false, message: null, until: null };
    const parsed = JSON.parse(row.value) as MaintenanceFlag;
    if (parsed.active && parsed.until && Date.now() >= parsed.until) {
      return { active: false, message: null, until: null };
    }
    return parsed;
  } catch {
    return { active: false, message: null, until: null };
  }
};

export const handleMaintenanceRequest = async (
  request: Request,
  env: Env,
): Promise<Response> => {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (
    !token ||
    !env.MAINTENANCE_TOKEN ||
    !safeEqual(token, env.MAINTENANCE_TOKEN)
  ) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }

  const b = body as {
    active?: unknown;
    message?: unknown;
    ttl_minutes?: unknown;
  };
  if (typeof b?.active !== "boolean") {
    return json({ error: "invalid_body" }, { status: 400 });
  }

  if (b.active === false) {
    await env.DB.prepare("DELETE FROM meta WHERE key = 'maintenance'").run();
    return json({ active: false });
  }

  const message =
    typeof b.message === "string" ? b.message.slice(0, 200) : null;
  const rawTtl = parseInt(String(b.ttl_minutes ?? 15), 10);
  const ttlMinutes = Math.min(
    Math.max(Number.isFinite(rawTtl) ? rawTtl : 15, 1),
    120,
  );
  const until = Date.now() + ttlMinutes * 60 * 1000;
  const value = JSON.stringify({ active: true, message, until });
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES ('maintenance', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(value)
    .run();
  return json({ active: true, message, until });
};
