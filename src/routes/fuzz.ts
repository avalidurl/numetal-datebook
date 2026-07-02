/**
 * Fuzzing pipeline: CI (GitHub Actions fuzz.yml) POSTs each run's result here; the admin
 * console renders the latest runs. Two surfaces:
 *   POST /api/fuzz/ingest  — token-gated (FUZZ_INGEST_TOKEN, NOT the operator ACCESS_KEY),
 *                            mounted ABOVE the access gate so CI can reach it without the
 *                            operator key. Persists the run and fans a summary to Slack.
 *   (the admin GET render lives in admin.ts as §13, access-gated with the rest of the console)
 *
 * Design: CI holds the GitHub context and pushes to us — the Worker never holds a GitHub
 * token and never calls back out to the GitHub API. Slug the same way status.numetal.xyz does.
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { timingSafeEqualStr } from "../util/timing";

export const fuzzRoutes = new Hono<{ Bindings: Env }>();

type Payload = {
  repo?: string;
  job?: string; // property | coverage-guided
  event?: string;
  branch?: string;
  commit_sha?: string;
  conclusion?: string; // success | failure | timed_out | cancelled
  crashes?: number;
  corpus_size?: number;
  exec_count?: number;
  duration_s?: number;
  run_url?: string;
  run_id?: string;
  detail?: unknown; // arbitrary JSON breakdown
};

const clampInt = (v: unknown, def = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
};
const clip = (v: unknown, n: number): string | null =>
  v == null ? null : String(v).slice(0, n);

async function toSlack(env: Env, p: Payload, crashed: boolean): Promise<void> {
  const url = env.FUZZ_SLACK_WEBHOOK_URL;
  if (!url) return; // dark until the #fuzzing webhook secret is set
  const icon = crashed ? "🔴" : p.conclusion === "success" ? "🟢" : "🟠";
  const head = crashed
    ? `${icon} *Fuzzing found a crash* — ${p.crashes} artifact(s)`
    : `${icon} Fuzz *${p.job}* — ${p.conclusion}`;
  const lines = [
    head,
    `repo \`${p.repo}\` · ${p.event ?? "?"} · \`${(p.commit_sha ?? "").slice(0, 8)}\``,
    p.corpus_size != null ? `corpus ${p.corpus_size} · execs ${p.exec_count ?? "?"} · ${p.duration_s ?? "?"}s` : null,
    p.run_url ? `<${p.run_url}|open the run ↗>` : null,
  ].filter(Boolean);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: lines.join("\n") }),
    });
  } catch {
    /* never let a Slack hiccup fail the ingest */
  }
}

fuzzRoutes.post("/api/fuzz/ingest", async (c) => {
  // Dedicated ingest token — CI carries this, never the operator ACCESS_KEY.
  const auth = c.req.header("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined;
  if (!c.env.FUZZ_INGEST_TOKEN || !bearer || !(await timingSafeEqualStr(bearer, c.env.FUZZ_INGEST_TOKEN))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  let p: Payload;
  try {
    p = (await c.req.json()) as Payload;
  } catch {
    return c.json({ error: "bad json" }, 400);
  }
  if (!p.repo || !p.job || !p.conclusion) {
    return c.json({ error: "repo, job, conclusion required" }, 422);
  }
  const crashes = clampInt(p.crashes, 0);
  const crashed = crashes > 0 || p.conclusion === "failure";

  try {
    await c.env.DB.prepare(
      `INSERT INTO fuzz_runs
        (repo, job, event, branch, commit_sha, conclusion, crashes, corpus_size, exec_count, duration_s, run_url, run_id, detail)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
       ON CONFLICT(run_id, job) DO UPDATE SET
        conclusion=?6, crashes=?7, corpus_size=?8, exec_count=?9, duration_s=?10, detail=?13`,
    )
      .bind(
        clip(p.repo, 120),
        clip(p.job, 40),
        clip(p.event, 40),
        clip(p.branch, 120),
        clip(p.commit_sha, 64),
        clip(p.conclusion, 40),
        crashes,
        p.corpus_size == null ? null : clampInt(p.corpus_size),
        p.exec_count == null ? null : clampInt(p.exec_count),
        p.duration_s == null ? null : clampInt(p.duration_s),
        clip(p.run_url, 300),
        clip(p.run_id, 40),
        p.detail == null ? null : JSON.stringify(p.detail).slice(0, 8000),
      )
      .run();
  } catch (e) {
    return c.json({ error: "db", detail: String(e) }, 500);
  }

  await toSlack(c.env, p, crashed);
  return c.json({ ok: true, crashed });
});
