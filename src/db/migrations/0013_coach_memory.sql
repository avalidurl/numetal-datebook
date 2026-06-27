-- 0013_coach_memory.sql — Phase 0: "capture before you coach".
-- The human-side episodic substrate for Ishtar Talk (the concierge coach). HUMANS ONLY —
-- keyed by the chat wallet `subject` (lowercased address). This is the compounding data asset
-- the moat depends on; the coach quality can lag, the data must start accruing now.
--   episodes        = typed, importance-scored records (advice, debrief, feedback, match, note)
--   user_facts      = extracted stable preferences (dedup-updated)
--   reflections     = synthesized, episode-citing insights (Phase 2 reflection job writes these)
--   coach_feedback  = the feedback->credit (discount) ledger; each row also mints a high-signal episode

CREATE TABLE IF NOT EXISTS episodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject     TEXT NOT NULL,                       -- lowercased wallet address (the human)
  kind        TEXT NOT NULL,                       -- advice | debrief | feedback | match | note
  content     TEXT NOT NULL,
  importance  REAL NOT NULL DEFAULT 0.5,           -- 0..1, for scored retrieval (recency × importance × relevance)
  source      TEXT NOT NULL DEFAULT 'coach',       -- coach | feedback | match | system
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_episodes_subject ON episodes (subject, id);
CREATE INDEX IF NOT EXISTS idx_episodes_created_at ON episodes (created_at);

CREATE TABLE IF NOT EXISTS user_facts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject     TEXT NOT NULL,
  fact        TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 0.5,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_facts_unique ON user_facts (subject, fact);

CREATE TABLE IF NOT EXISTS reflections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject     TEXT NOT NULL,
  summary     TEXT NOT NULL,
  cites       TEXT,                                -- JSON array of episode ids this reflection draws from
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reflections_subject ON reflections (subject, id);

-- Feedback -> discount ledger. The discount BUYS the moat data (a debrief = "what actually landed").
-- `day` + the per-day cap (enforced in code) stop feedback-farming for free credits.
CREATE TABLE IF NOT EXISTS coach_feedback (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subject         TEXT NOT NULL,
  kind            TEXT NOT NULL,                   -- rating | debrief
  rating          INTEGER,                         -- 1..5 (rating kind)
  body            TEXT,                            -- free text (debrief)
  credits_awarded INTEGER NOT NULL DEFAULT 0,
  day             TEXT NOT NULL,                   -- UTC 'YYYY-MM-DD' for the per-day award cap
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_coach_feedback_subject_day ON coach_feedback (subject, day);
