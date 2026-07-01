-- Per-owner agent DELIVERY webhook (generic, runtime-agnostic match relay).
--
-- The agent-relay notify channel POSTs a SIGNED "come look" payload (the matches magic-link — NO PII,
-- never contact) to the owner's OWN agent webhook; the agent (OpenClaw / Hermes / Claude / Codex /
-- custom) verifies the HMAC and relays to its human in whatever app it lives in. Ishtar holds ZERO
-- chat-app credentials and never learns the channel. This migration adds the per-owner delivery target:
--
--   owner_deliveries — at most one delivery webhook per owner. `url` + `secret` are SEALED at rest
--   (crypto/box, same as owners.contact_ref). `secret` is the per-owner HMAC shared secret the agent
--   verifies the POST with. The channel is OFF venue-wide until AGENT_RELAY_ENABLED is set, and canSend
--   is false for any owner without an active row, so this rolls forward safely with NO behaviour change
--   and needs no backfill.
CREATE TABLE IF NOT EXISTS owner_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES owners(id),
  url TEXT NOT NULL,                                  -- SEALED https webhook URL (the agent's inbound)
  secret TEXT NOT NULL,                               -- SEALED per-owner HMAC shared secret
  status TEXT NOT NULL DEFAULT 'active',              -- active | disabled
  verified_at TEXT,                                  -- set after a reachability probe (Phase 2); nullable
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- At most one delivery row per owner (the resolver takes the newest active; the unique keeps it clean).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_owner_deliveries_owner ON owner_deliveries(owner_id);
CREATE INDEX IF NOT EXISTS idx_owner_deliveries_owner ON owner_deliveries(owner_id, status);
