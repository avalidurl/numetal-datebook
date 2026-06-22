-- 0006_error_events.sql — self-contained error ledger.
-- Workers Logs + the Query Builder stay the rich, searchable sink (the "Sentry"); this small table
-- is the always-on counter the operator console reads, so "errors today / 5xx" is a tile in /admin
-- without leaving the page. Routing metadata only — never any heart-file content. Bounded by the
-- retention sweep (src/retention.ts) so it can't grow unbounded.
CREATE TABLE IF NOT EXISTS error_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status INTEGER NOT NULL DEFAULT 0,   -- HTTP status (>=500) or 0 for non-HTTP (cron / explicit capture)
  type TEXT NOT NULL DEFAULT 'Error',  -- error name / class (e.g. http_500, TypeError)
  message TEXT,                        -- short message, truncated; no PII / heart-file content
  route TEXT,                          -- request path, or 'scheduled' for the cron
  method TEXT,                         -- HTTP method when applicable
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_error_events_created ON error_events(created_at);
CREATE INDEX IF NOT EXISTS idx_error_events_status ON error_events(status);
