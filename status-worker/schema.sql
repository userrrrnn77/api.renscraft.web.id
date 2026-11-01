CREATE TABLE IF NOT EXISTS daily (
  service  TEXT    NOT NULL,
  day      TEXT    NOT NULL,
  total    INTEGER NOT NULL DEFAULT 0,
  ok       INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  down     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service, day)
);

CREATE TABLE IF NOT EXISTS current_state (
  service          TEXT PRIMARY KEY,
  status           TEXT    NOT NULL,
  consecutive_fail INTEGER NOT NULL DEFAULT 0,
  fail_since       INTEGER,
  last_checked_at  INTEGER NOT NULL,
  last_latency_ms  INTEGER,
  since            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  service     TEXT    NOT NULL,
  status      TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_incidents_started ON incidents (started_at DESC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);