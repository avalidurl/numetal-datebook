-- Match-notify layer (The Window — enrolled-human MATCH alert).
--
-- When an enrolled human (one who arrived via a featured post) gets a MATCH — a couple forms that
-- involves their owner — we email them a "come look" alert pointing at their matches page. This
-- migration adds the durable side of that:
--
--   (1) owners.alert_channels — the owner's enabled notify channels (CSV; default 'email'). A future
--       branch flips this to e.g. 'email,telegram' when the owner wires another channel. NULL/absent →
--       the code default ['email'] still applies, so existing rows need no backfill.
--
--   (2) notifications — one row PER (owner, kind, ref, channel) delivery attempt. The UNIQUE constraint
--       is the idempotency guard: a replayed/retried beat (the match coordinator is a DO whose beat can
--       re-enter) can never double-send the same alert. `ref` is the opaque reference for the event
--       (e.g. the couple id for a 'match'); `status` records the dispatch outcome (sent|failed|skipped).
--
-- NOTE (enrol-branch dependency): the trigger that decides WHO is an enrolled human reads
-- featured_posts.owner_id (added by the sibling enrol branch). This migration does NOT add that column —
-- the notify code feature-detects it at runtime and no-ops the featured-human gate until it exists.

-- (1) Per-owner enabled notify channels (CSV). Default 'email'. notifyOwner() falls back to ['email']
-- when the column is absent/empty, so this is safe to roll forward independently.
ALTER TABLE owners ADD COLUMN alert_channels TEXT NOT NULL DEFAULT 'email';

-- (2) Delivery ledger + idempotency. One attempt row per (owner, kind, ref, channel). A retry/replay
-- hits the UNIQUE index and is skipped, so an enrolled human is never double-emailed for one match.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,                          -- the enrolled owner being notified
  kind TEXT NOT NULL,                                 -- 'match' (extensible: 'reveal_ready', ...)
  ref TEXT NOT NULL,                                  -- opaque event ref — e.g. the couple id, as text
  channel TEXT NOT NULL,                              -- 'email' | 'xmtp' | 'telegram' | 'imessage' | ...
  status TEXT NOT NULL DEFAULT 'sent',               -- sent | failed | skipped
  reason TEXT,                                        -- failure/skip reason (channel adapter's {reason})
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Idempotency key: at most one delivery row per (owner, kind, ref, channel). The dispatcher INSERTs a
-- claim row FIRST (ON CONFLICT DO NOTHING); if the claim is lost the alert was already handled → skip.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_notifications_owner_kind_ref_channel
  ON notifications(owner_id, kind, ref, channel);

-- Audit/list lookup: an owner's notifications newest-first.
CREATE INDEX IF NOT EXISTS idx_notifications_owner ON notifications(owner_id, created_at);
