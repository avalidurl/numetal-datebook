-- 0009_relay_binding.sql — bind each Persona Relay session to the invite + the claiming Privy user
-- and give it an expiry (red-team H7/C1). Closes: stale-session redemption by a different login,
-- the concurrent-claim race, and unbounded relay-secret lifetime.
ALTER TABLE relay_sessions ADD claimed_by TEXT;
ALTER TABLE relay_sessions ADD invite_id INTEGER;
ALTER TABLE relay_sessions ADD expires_at TEXT;
