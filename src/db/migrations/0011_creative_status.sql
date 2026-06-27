-- 0011_creative_status.sql — lightweight status tracking for the internal Creative & Marketing
-- dashboard (admin-only). One row per tracked item (a video, a go-to-market task); the founder
-- cycles its status from the console. No PII; bounded by the fixed item set.
CREATE TABLE IF NOT EXISTS creative_status (
  item_key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'todo',
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
