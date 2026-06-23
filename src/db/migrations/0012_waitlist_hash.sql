-- 0012_waitlist_hash.sql — encrypt waitlist emails at rest (red-team data-privacy). `email` now
-- stores the SEALED (AES-GCM) value; `email_hash` (sha256 of the lowercased email) is the
-- deterministic dedup key. Legacy plaintext rows keep working (email_hash stays NULL; SQLite treats
-- NULLs as distinct, so they don't collide).
ALTER TABLE waitlist ADD email_hash TEXT;
DROP INDEX IF EXISTS idx_waitlist_email;
CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_email_hash ON waitlist(email_hash);
