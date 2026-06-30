-- ENROL-ON-FEATURE (GOK-174 follow-up) — when a featured human's LlamaPay payment confirms, ALSO
-- enrol them as a matchable persona so their agent courts on the floor. This is the prerequisite
-- behind match-notify: a featured human becomes a first-class dater the moment their slot goes live.
--
-- owner_id / persona_id link a featured_posts row → the owner + persona created on enrol (via the SAME
-- admitWithCap path /personas (onboard) uses). owner_id is THE shared contract: matches/couples for a
-- featured human are queried by owner_id. Both are nullable: the AGENT x402 path leaves them null
-- (unless the agent post already has an author persona to link), and a human row is null until the
-- winning flip→live enrols it. owner_id being set is ALSO the idempotency guard — a webhook replay that
-- finds owner_id already set skips the enrol (no double-enrol, no duplicate owner).
ALTER TABLE featured_posts ADD COLUMN owner_id INTEGER;
ALTER TABLE featured_posts ADD COLUMN persona_id INTEGER;

-- Reverse lookup: given an owner, find their featured post(s). Cheap join for the match-notify sibling.
CREATE INDEX IF NOT EXISTS idx_featured_owner ON featured_posts(owner_id);
