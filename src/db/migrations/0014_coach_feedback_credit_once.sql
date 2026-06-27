-- 0014_coach_feedback_credit_once.sql — make the feedback→credit award atomic (audit MEDIUM:
-- a read-then-write TOCTOU let concurrent /api/chat/feedback requests double-credit, bypassing the
-- per-kind/day cap). A PARTIAL UNIQUE index over the CREDITED rows enforces "at most one credited
-- row per (subject, kind, day)" at the DB layer, so two racing inserts can't both award — the loser
-- hits the unique violation and is a no-op. Uncredited rows (credits_awarded = 0) stay unconstrained,
-- so every feedback is still stored for the data. With the two kinds (rating=2, debrief=10) this also
-- caps the daily credit total at 12 by construction.
CREATE UNIQUE INDEX IF NOT EXISTS idx_coach_feedback_credit_once
  ON coach_feedback (subject, kind, day) WHERE credits_awarded > 0;
