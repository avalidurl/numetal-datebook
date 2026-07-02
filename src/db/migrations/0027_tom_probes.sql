-- 0027_tom_probes.sql — Theory-of-Mind probe results (P5).
-- One row per scored probe: how accurately a prober persona INFERRED its partner's sealed
-- heart-file preferences (hard/soft prefs). The score is EARNED — computed by comparing the
-- prober's stated inference against the decrypted ground-truth prefs (src/match/tom.ts), never a
-- placeholder. HeartBench v2 reads this exact table (name + columns are a fixed cross-agent contract).
-- No heart-file content is stored here; `detail` holds only the per-field hit/miss breakdown (JSON).
CREATE TABLE IF NOT EXISTS tom_probes (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  couple_id          INTEGER NOT NULL,                    -- the couple this probe belongs to
  prober_persona_id  INTEGER NOT NULL,                    -- the persona doing the inferring
  target_persona_id  INTEGER NOT NULL,                    -- the persona whose prefs were inferred
  score              REAL NOT NULL,                       -- 0..1 earned ToM accuracy
  detail             TEXT,                                -- JSON: per-field hits/misses/hallucinations
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tom_probes_couple ON tom_probes (couple_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tom_probes_prober ON tom_probes (prober_persona_id, created_at);
