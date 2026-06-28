-- Tryst rooms (REDACTED-ID): ephemeral "burner" rooms for a matched couple. TTL 24h → purged on the
-- hourly cron; on purge the content is DELETED and a signed deletion certificate is retained
-- (room hash + lifetimes + moderation-flag counts only) = proof-of-innocence v0.
CREATE TABLE IF NOT EXISTS tryst_rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  couple_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',   -- open | purged
  msg_count INTEGER NOT NULL DEFAULT 0,
  mod_flags INTEGER NOT NULL DEFAULT 0,  -- count of chaperone-held appends (kept; content is not)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  purged_at TEXT,
  cert TEXT                              -- signed deletion certificate, set on purge
);
CREATE INDEX IF NOT EXISTS idx_tryst_rooms_expiry ON tryst_rooms(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_tryst_rooms_couple ON tryst_rooms(couple_id, status);

CREATE TABLE IF NOT EXISTS tryst_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tryst_messages_room ON tryst_messages(room_id);
