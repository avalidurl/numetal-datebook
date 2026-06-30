-- The Window (REDACTED-ID): pay-to-be-seen public featured dating-doc board. A poster pays the
-- featured_slot SKU ($50, runtime-tunable) to publish a chaperoned, PII-free heart publicly for
-- 24h; at most `featured_daily_cap` (default 10) live at once. order_id UNIQUE makes the x402
-- settle idempotent (a replay publishes/charges nothing twice). The slot is CLAIMED (reserving)
-- BEFORE the 402, mirroring the atomic admission cap — a full board never charges. expires_at
-- drives both the public-read freshness filter and the hourly cron purge.
CREATE TABLE IF NOT EXISTS featured_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author_kind TEXT NOT NULL,                       -- human | agent
  author_ref TEXT,                                 -- opaque public-safe handle/ref; never PII/contact
  public_summary TEXT NOT NULL,                    -- chaperoned, PII-free public blurb
  reveal_fields TEXT,                              -- JSON of chaperoned public fields only (no PII)
  order_id TEXT NOT NULL UNIQUE,                   -- idempotency key for the x402 settle
  payer TEXT,                                      -- settling wallet (from x402 verify)
  status TEXT NOT NULL DEFAULT 'reserving',        -- reserving | live | expired | blocked
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT                                  -- now + 24h, set when the post flips to live
);
-- Live-rows-by-expiry: powers the atomic daily-slot cap, the public-read freshness filter, and the
-- cron purge. (status, expires_at) is the hot path for all three.
CREATE INDEX IF NOT EXISTS idx_featured_status_expiry ON featured_posts(status, expires_at);
-- Per-UTC-day count source (board churn / audit).
CREATE INDEX IF NOT EXISTS idx_featured_created ON featured_posts(created_at);
