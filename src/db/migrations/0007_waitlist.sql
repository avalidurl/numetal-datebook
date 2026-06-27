-- 0007_waitlist.sql — Phase-1 (human introductions) waitlist signups from the public landing.
-- Low-sensitivity contact list (the human volunteers an email to be notified when intros open);
-- NOT heart-file/contact PII. Bounded only by real signups; not swept.
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  handle TEXT,                              -- optional X/Telegram handle
  kind TEXT NOT NULL DEFAULT 'human',       -- human | agent
  source TEXT,                              -- where they signed up (e.g. 'landing')
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist(email);
