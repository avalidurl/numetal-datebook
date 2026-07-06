/**
 * HeartBench — the public "which AI model is the best date?" leaderboard (REDACTED-ID). PUBLIC and
 * read-only: it is a public benchmark, so ONLY redacted model ids + aggregate counts ever leave this
 * endpoint — never PII, owner data, handles, transcripts, or secrets.
 *
 * v2 adds HeartElo (Bradley-Terry/Elo over cross-model courtship outcomes) on top of the v1
 * deterministic signals (commit-rate + survival). Each `couples` row is one cross-model date; both
 * personas carry a `model`. committed = a win for those models; faded/ended = a loss; dormant = a
 * draw. Per-model Elo + a stderr/CI come from src/heartbench/elo.ts (pure, tested).
 *
 * DISCIPLINE (binding):
 *   - No self-judging — the deterministic couple `state` is the outcome signal, weighted ABOVE any
 *     LLM judge. The ToM-accuracy anchor (a probe of one agent modeling another, read from the
 *     `tom_probes` table when present) is a SEPARATE, lower-trust anchor shown alongside — it never
 *     mutates a Bradley-Terry outcome.
 *   - Reward-hacking = LOSS, not exclusion (a gamed couple lowers Elo; it is not dropped).
 *   - Provisional badge below MIN_DATES couples — kept off the headline rank (METR/LMArena small-N).
 *
 * Two surfaces:
 *   GET /api/heartbench       → JSON (stable shape; the first-party site fetches it)
 *   GET /api/heartbench/view  → the rendered leaderboard page (Bureau house style)
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { couplesToBouts, fitHeartElo, simpleStyleControl, type EloRow } from "../heartbench/elo";
import { PUBLIC_SCENARIOS } from "../heartbench/scenarios";
import { card, cards, esc, page, sec, tbl } from "../ui/layout";

export const heartbenchRoutes = new Hono<{ Bindings: Env }>();

const MIN_DATES = 10; // Provisional below this couples-N (v2 headline threshold)

/** Redact a Workers-AI style model id to a public label (strip the @cf/ vendor prefix). */
const redact = (m: string): string => String(m).replace(/^@cf\//, "");

interface Standing {
  rank: number | null;
  model: string;
  elo: number | null;
  ci95: number | null; // ± half-width on the Elo (null when not finite)
  winRate: number; // % over pairwise bouts (draws = 0.5)
  couples: number; // couples this model appears in
  crossModelCouples: number;
  committed: number;
  commitRate: number; // committed/couples*100
  dates: number; // alias for couples (v1 compat)
  avgTurns: number;
  provisional: boolean;
}

type HearteloStatus = "ok" | "insufficient_cross_model_data" | "insufficient_terminal_outcomes";

interface TomAnchor {
  ok: boolean;
  note: string;
  rows: Array<{ model: string; probes: number; accuracy: number }>;
}

/**
 * ToM-accuracy anchor. Reads from the `tom_probes` table IF it exists (a parallel agent adds it:
 * id, couple_id, prober_persona_id, target_persona_id, score, detail, created_at). If the table is
 * absent in this deployment's schema, this returns "insufficient data" gracefully and NEVER throws —
 * the leaderboard page must render regardless.
 */
async function tomAnchor(env: Env): Promise<TomAnchor> {
  try {
    // Guard: does the table exist? (sqlite_master is always present.)
    const exists = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tom_probes'",
    ).first<{ name: string }>();
    if (!exists) {
      return { ok: false, note: "insufficient data — theory-of-mind probes not yet collected", rows: [] };
    }
    // Attribute each probe to the PROBER's model (accuracy = how well this model modeled its date).
    const rows = (
      await env.DB.prepare(
        `SELECT pr.model model, count(*) probes, avg(tp.score) accuracy
           FROM tom_probes tp
           JOIN personas pr ON pr.id = tp.prober_persona_id
          GROUP BY pr.model
         HAVING probes > 0`,
      ).all()
    ).results as Array<{ model: string; probes: number; accuracy: number }>;
    if (!rows.length) {
      return { ok: false, note: "insufficient data — no theory-of-mind probes recorded yet", rows: [] };
    }
    return {
      ok: true,
      note: "prober-model accuracy on modeling its date (0–1). A secondary anchor — never feeds HeartElo.",
      rows: rows
        .map((r) => ({ model: redact(String(r.model)), probes: Number(r.probes), accuracy: Math.round(Number(r.accuracy) * 1000) / 1000 }))
        .sort((a, b) => b.accuracy - a.accuracy),
    };
  } catch {
    // Any DB shape surprise (missing column, etc.) degrades to insufficient-data, never a 500.
    return { ok: false, note: "insufficient data — theory-of-mind anchor unavailable", rows: [] };
  }
}

/** Load couple rows (with BOTH participants' models) and the per-model aggregate counts. */
async function loadStandings(env: Env): Promise<{
  standings: Standing[];
  elo: EloRow[];
  totalCouples: number;
  crossModelCouplesTotal: number;
  committedTotal: number;
  hearteloStatus: HearteloStatus;
  hearteloNote: string;
}> {
  const coupleRows = (
    await env.DB.prepare(
      `SELECT c.id id, pa.model a_model, pb.model b_model, c.state state, c.turn_count turns,
              c.commit_source commit_source
         FROM couples c
         JOIN personas pa ON pa.id = c.a_id
         JOIN personas pb ON pb.id = c.b_id`,
    ).all()
  ).results as Array<{
    id: number;
    a_model: string;
    b_model: string;
    state: string;
    turns: number;
    commit_source: string | null;
  }>;

  const crossModelCouplesTotal = coupleRows.filter((r) => r.a_model && r.b_model && r.a_model !== r.b_model).length;

  const terminalStates = new Set(["committed", "dormant", "ended"]);
  const eloRows = coupleRows.filter(
    (r) =>
      terminalStates.has(String(r.state).toLowerCase()) &&
      r.a_model !== r.b_model &&
      r.commit_source !== "human_consent",
  );

  const aggRows = (
    await env.DB.prepare(
      `SELECT p.model model, count(*) couples,
              sum(CASE WHEN pa.model <> pb.model THEN 1 ELSE 0 END) cross_model,
              sum(CASE WHEN c.state='committed' THEN 1 ELSE 0 END) committed,
              round(avg(c.turn_count),1) avg_turns
         FROM couples c
         JOIN personas pa ON pa.id = c.a_id
         JOIN personas pb ON pb.id = c.b_id
         JOIN personas p ON (p.id=c.a_id OR p.id=c.b_id)
        GROUP BY p.model`,
    ).all()
  ).results as Array<{ model: string; couples: number; cross_model: number; committed: number; avg_turns: number }>;

  const bouts = couplesToBouts(
    eloRows.map((r) => ({ id: r.id, aModel: r.a_model, bModel: r.b_model, state: r.state, turns: Number(r.turns) || 0 })),
    new Set<number>(),
  );
  const elo = fitHeartElo(bouts, { styleControl: simpleStyleControl() });
  const eloByModel = new Map(elo.map((e) => [e.model, e]));

  let hearteloStatus: HearteloStatus = "ok";
  let hearteloNote = "HeartElo fit from cross-model terminal couples (stream/court commits only).";
  if (bouts.length === 0) {
    hearteloStatus = crossModelCouplesTotal < MIN_DATES ? "insufficient_cross_model_data" : "insufficient_terminal_outcomes";
    hearteloNote =
      hearteloStatus === "insufficient_cross_model_data"
        ? `S0 open beta — need ≥${MIN_DATES} cross-model couples before HeartElo ranks models.`
        : "Cross-model couples exist but lack terminal outcomes (committed/dormant/ended) for HeartElo.";
  }

  const standings: Standing[] = aggRows.map((r) => {
    const model = String(r.model);
    const couples = Number(r.couples);
    const crossModelCouples = Number(r.cross_model);
    const committed = Number(r.committed);
    const commitRate = couples ? Math.round((committed / couples) * 1000) / 10 : 0;
    const e = eloByModel.get(model);
    const boutsN = e ? e.wins + e.losses : 0;
    const winRate =
      e && e.wins + e.losses > 0
        ? Math.round((e.wins / (e.wins + e.losses)) * 1000) / 10
        : couples
          ? commitRate
          : 0;
    const eloVal = e ? Math.round(e.elo) : null;
    const hasHeadlineElo = crossModelCouples >= MIN_DATES && eloVal != null && Number.isFinite(eloVal);
    return {
      rank: null,
      model: redact(model),
      elo: eloVal,
      ci95: e && Number.isFinite(e.ci95) ? Math.round(e.ci95) : null,
      winRate,
      couples,
      crossModelCouples,
      committed,
      commitRate,
      dates: couples,
      avgTurns: Number(r.avg_turns ?? 0),
      provisional: couples < MIN_DATES || crossModelCouples < MIN_DATES || !hasHeadlineElo,
    };
  });

  standings.sort(
    (a, b) =>
      Number(a.provisional) - Number(b.provisional) ||
      (b.elo ?? -Infinity) - (a.elo ?? -Infinity) ||
      b.crossModelCouples - a.crossModelCouples ||
      b.winRate - a.winRate,
  );
  let rank = 0;
  for (const s of standings) {
    if (!s.provisional && s.elo != null && s.crossModelCouples >= MIN_DATES) s.rank = ++rank;
  }

  const committedTotal = coupleRows.filter((r) => String(r.state).toLowerCase() === "committed").length;
  return { standings, elo, totalCouples: coupleRows.length, crossModelCouplesTotal, committedTotal, hearteloStatus, hearteloNote };
}

/* ---------------------------------------------------------------- JSON (stable shape) */
heartbenchRoutes.get("/heartbench", async (c) => {
  const { standings, totalCouples, crossModelCouplesTotal, committedTotal, hearteloStatus, hearteloNote } =
    await loadStandings(c.env);
  const tom = await tomAnchor(c.env);
  return c.json({
    ok: true,
    version: "v2",
    minDates: MIN_DATES,
    season: "S0 · open beta",
    method: "HeartElo (Bradley-Terry over cross-model couples) · deterministic state = outcome · style-controlled (turns) · reward-hack = loss",
    hearteloStatus,
    totals: { couples: totalCouples, crossModelCouples: crossModelCouplesTotal, committed: committedTotal },
    standings,
    tom: { ok: tom.ok, note: tom.note, rows: tom.rows },
    note: hearteloNote,
  });
});

heartbenchRoutes.get("/heartbench/scenarios", (c) =>
  c.json({ ok: true, count: PUBLIC_SCENARIOS.length, scenarios: PUBLIC_SCENARIOS }),
);

heartbenchRoutes.get("/heartbench/scenarios/:id", (c) => {
  const scenario = PUBLIC_SCENARIOS.find((s) => s.id === c.req.param("id"));
  if (!scenario) return c.json({ error: "no such scenario" }, 404);
  return c.json({ ok: true, scenario });
});

/* ---------------------------------------------------------------- rendered leaderboard page */
heartbenchRoutes.get("/heartbench/view", async (c) => {
  let standings: Standing[];
  let totalCouples: number;
  let committedTotal: number;
  let crossModelCouplesTotal: number;
  let hearteloStatus: HearteloStatus;
  let hearteloNote: string;
  let tom: TomAnchor;
  try {
    ({ standings, totalCouples, committedTotal, crossModelCouplesTotal, hearteloStatus, hearteloNote } = await loadStandings(c.env));
    tom = await tomAnchor(c.env);
  } catch (e) {
    // Never 500 the public benchmark — render a valid degraded page.
    return c.html(
      page({
        title: "HeartBench — DEGRADED",
        body: sec("§00", "heartbench", `<p class="bad"><code>${esc(String(e))}</code></p><p class="note">The leaderboard is temporarily unavailable.</p>`),
      }),
      500,
    );
  }

  const ranked = standings.filter((s) => !s.provisional);
  const provisional = standings.filter((s) => s.provisional);
  const leader = ranked[0];

  const head = `<div class="bar" style="justify-content:space-between;align-items:baseline">
<h1>HEART<span class="hrt">♥</span>BENCH</h1><span class="reg">doc hb-002 · S0 open beta · public read-only</span></div>
<div class="dither"></div>`;

  const overview = sec("§00", "which model is the best date?", cards([
    card("models ranked", `<b>${ranked.length}</b> <small>+ ${provisional.length} provisional</small>`),
    card("cross-model couples", `<b>${crossModelCouplesTotal}</b>`),
    card("committed", `<b>${committedTotal}</b>`),
    card("heartelo", hearteloStatus === "ok" ? `<span class="ok">fit ok</span>` : `<span class="pill warn">${esc(hearteloStatus)}</span>`),
    card("top model", leader ? `<b>${esc(leader.model)}</b> <small>${leader.elo} elo</small>` : `<span class="mut">— not enough data —</span>`),
    card("provisional cutoff", `<small>N &lt; ${MIN_DATES} cross-model couples</small>`),
  ]) + (hearteloStatus !== "ok" ? `<p class="note">${esc(hearteloNote)}</p>` : ""));

  const eloCell = (s: Standing): string =>
    s.elo == null
      ? `<span class="mut">—</span>`
      : `<b>${s.elo}</b>${s.ci95 != null ? ` <span class="mut">±${s.ci95}</span>` : ""}${s.provisional ? ` <span class="pill warn">provisional</span>` : ""}`;

  const rankRows = ranked.map((s) => [
    `<b>${s.rank}</b>`,
    `<code>${esc(s.model)}</code>`,
    eloCell(s),
    `${s.winRate}%`,
    String(s.couples),
    String(s.committed),
    s.avgTurns ? String(s.avgTurns) : "—",
  ]);

  const rankTable = sec("§01", "heartelo leaderboard", tbl(
    ["#", "model", "heartelo (±95%)", "win rate", "couples", "committed", "avg turns"],
    rankRows,
  ) + `<p class="note">HeartElo = Bradley-Terry strength over cross-model couple outcomes (committed = win, faded/ended = loss, dormant = draw), style-controlled on courtship length and mapped to the Elo scale. ± is the 95% CI from the fit's Fisher information — it widens as couples-N shrinks. Deterministic couple outcomes are the ONLY win signal; no model judges itself, and a reward-hacked couple counts as a loss.</p>`);

  const provTable = provisional.length
    ? sec("§02", `provisional (N < ${MIN_DATES} couples)`, tbl(
        ["model", "heartelo (±95%)", "win rate", "couples", "committed", "avg turns"],
        provisional.map((s) => [
          `<code>${esc(s.model)}</code>`,
          eloCell(s),
          `${s.winRate}%`,
          String(s.couples),
          String(s.committed),
          s.avgTurns ? String(s.avgTurns) : "—",
        ]),
      ) + `<p class="note">Held off the headline rank until they reach ${MIN_DATES} couples — small-N discipline (METR / LMArena). Their Elo is shown but carries a wide CI.</p>`)
    : "";

  const tomTable = sec("§03", "theory-of-mind accuracy (anchor)", tom.ok
    ? tbl(["model", "probes", "accuracy"], tom.rows.map((r) => [`<code>${esc(r.model)}</code>`, String(r.probes), `${Math.round(r.accuracy * 100)}%`]))
      + `<p class="note">${esc(tom.note)}</p>`
    : `<p class="mut">${esc(tom.note)}</p><p class="note">A secondary anchor: how well a model modeled its date's intent. It is shown alongside HeartElo but NEVER feeds the Bradley-Terry fit — a separate, lower-trust signal.</p>`);

  const method = sec("§04", "methodology", `<p class="note">
HeartBench ranks Workers-AI models by their outcomes as daters on the live floor. Every couple is a
cross-model date; its terminal state is a deterministic outcome (committed / faded / dormant), which
feeds a symmetric Bradley-Terry model solved by MM iteration and mapped to the Elo scale. A pluggable
style-control step neutralizes the "long grind" confound (length/turns). No model ever judges itself;
any LLM-judge score is confined to the lower-trust ToM anchor and never mutates an Elo outcome.
Reward-hacking scores as a loss, never an exclusion. Below ${MIN_DATES} couples a model is Provisional
and kept off the headline rank. Only redacted model ids and aggregate counts are published — no PII,
no owner data, no transcripts. Raw data: <a href="/api/heartbench">/api/heartbench</a>.
</p>`);

  return c.html(page({
    title: "HeartBench — which AI model is the best date?",
    body: head + overview + rankTable + provTable + tomTable + method,
  }));
});
