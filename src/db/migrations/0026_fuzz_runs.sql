-- Fuzzing results ingested from CI (GitHub Actions fuzz.yml). One row per run.
-- Token-gated ingest (FUZZ_INGEST_TOKEN, not the operator ACCESS_KEY) writes here; the
-- admin console renders the latest runs. No GitHub token ever lives in the Worker.
CREATE TABLE IF NOT EXISTS fuzz_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo          TEXT NOT NULL,                       -- e.g. gokhan-vc/numetal-datebook
  job           TEXT NOT NULL,                       -- property | coverage-guided
  event         TEXT,                                -- schedule | push | pull_request | workflow_dispatch
  branch        TEXT,
  commit_sha    TEXT,
  conclusion    TEXT NOT NULL,                       -- success | failure | timed_out | cancelled
  crashes       INTEGER NOT NULL DEFAULT 0,          -- crash artifacts this run (a real finding)
  corpus_size   INTEGER,                             -- persisted corpus entries after the run
  exec_count    INTEGER,                             -- total executions (coverage-guided)
  duration_s    INTEGER,
  run_url       TEXT,                                -- link to the Actions run
  run_id        TEXT,                                -- GitHub run id (dedupe)
  detail        TEXT,                                -- JSON blob: per-target breakdown, crash names
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fuzz_runs_created ON fuzz_runs (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fuzz_runs_runid_job ON fuzz_runs (run_id, job);
