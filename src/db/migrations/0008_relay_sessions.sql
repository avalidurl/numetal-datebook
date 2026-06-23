-- 0008_relay_sessions.sql — in-flight Persona Relay (age-assurance) session state.
-- Holds the per-owner relayToken/relaySecret/privacyPassToken between widget start and claim
-- redemption. Server-side only (never sent to the client). One in-flight check per owner.
CREATE TABLE IF NOT EXISTS relay_sessions (
  owner_id INTEGER PRIMARY KEY,
  relay_token TEXT NOT NULL,
  relay_secret TEXT NOT NULL,           -- sensitive; server-side only
  privacy_pass_token TEXT NOT NULL,
  claim_type TEXT,
  status TEXT NOT NULL DEFAULT 'created', -- created | passed | failed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (owner_id) REFERENCES owners(id) ON UPDATE no action ON DELETE no action
);
