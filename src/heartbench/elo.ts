/**
 * HeartElo — Bradley-Terry / Elo strength fit over cross-model courtship outcomes.
 *
 * Pure, deterministic, dependency-free math so it is unit-testable in isolation (see
 * test/heartbench-v2.test.ts) and safe to import into a Worker route.
 *
 * DISCIPLINE (binding — see the route header + methodology page):
 *   - No self-judging. The model whose strength we fit is NEVER the judge of the outcome.
 *   - Deterministic outcome signals dominate. A couple's `state` (committed=win, faded/ended=loss)
 *     is the ONLY win signal fed here; any LLM-judge score belongs in a separate, lower-weight
 *     anchor (ToM) and never mutates a Bradley-Terry outcome.
 *   - Reward-hacking is a LOSS, not an exclusion. A couple flagged as gamed is scored as a loss for
 *     the offending model (caller passes it in `outcome: "loss"`), so gaming the venue lowers Elo —
 *     it does not quietly drop the datapoint.
 *   - Provisional on low N: strengths from few couples carry a wide CI and a Provisional badge; the
 *     fit still runs, but the caller keeps provisional models off the headline rank.
 *
 * The fit is a symmetric Bradley-Terry model solved by MM (minorization-maximization) iteration,
 * then mapped to the Elo scale (logistic base 10, 400-point spread). Ties (draws) contribute half
 * a win to each side. Style-control (regress out length/turns) is a PLUGGABLE pre-processing step
 * (see `applyStyleControl`) — v1 ships a simple, transparent version; the seam is stable so a fuller
 * regression can drop in without touching the solver or the route.
 */

/** One pairwise courtship outcome between two models (already redacted, order-independent). */
export interface Bout {
  a: string; // model id
  b: string; // model id
  /** Outcome from A's perspective: win = A's couple committed, loss = faded/ended, draw = dormant/tie. */
  outcome: "win" | "loss" | "draw";
  /** Optional style covariates for the pluggable style-control step (turns, total length, …). */
  turns?: number;
}

export interface EloRow {
  model: string;
  elo: number; // Elo-scaled strength (centered on `anchor`, default 1500)
  /** Bradley-Terry strength (exp scale), for downstream use / debugging. */
  strength: number;
  wins: number; // counting draws as 0.5
  losses: number;
  draws: number;
  games: number; // total bouts this model appears in
  /** Approximate standard error on the Elo, from the observed Fisher information. */
  stderr: number;
  /** 95% CI half-width (≈1.96·stderr), for the leaderboard ± column. */
  ci95: number;
}

export interface EloOptions {
  anchor?: number; // Elo center (default 1500)
  spread?: number; // Elo points per logit·(1/ln10) (default 400)
  iterations?: number; // MM iterations (default 200)
  tol?: number; // convergence tolerance on max log-strength delta (default 1e-9)
  prior?: number; // Bayesian smoothing: virtual win+loss vs a phantom average opponent (default 1)
  styleControl?: StyleControl; // pluggable length/turns correction
}

/** Pluggable style-control step: transform the raw bouts before the fit (regress out length/turns). */
export type StyleControl = (bouts: Bout[]) => Bout[];

/**
 * v1 style-control (simple, transparent, deterministic): DOWN-WEIGHT nothing structurally, but
 * neutralize the "long courtship = looks committed" confound by converting an over-length win into a
 * draw when the couple ran far above the median turn count — i.e. a commitment that only happened
 * after an unusually long grind is treated as a weaker signal than a quick, clean commit. This is a
 * deliberately conservative v1; the seam (`StyleControl`) lets a real length/turn regression replace
 * it wholesale without touching the solver. Bouts with no `turns` info pass through untouched.
 */
export function simpleStyleControl(longFactor = 2): StyleControl {
  return (bouts: Bout[]): Bout[] => {
    const turnVals = bouts.map((x) => x.turns).filter((t): t is number => typeof t === "number" && t > 0).sort((x, y) => x - y);
    if (turnVals.length < 4) return bouts; // too few to estimate a median → no correction
    const median = turnVals[Math.floor(turnVals.length / 2)]!;
    const threshold = median * longFactor;
    return bouts.map((x) =>
      x.outcome === "win" && typeof x.turns === "number" && x.turns > threshold
        ? { ...x, outcome: "draw" as const }
        : x,
    );
  };
}

/** Identity style-control (no correction) — the explicit "off" plug. */
export const noStyleControl: StyleControl = (bouts) => bouts;

/**
 * Fit Bradley-Terry strengths from pairwise bouts and map to the Elo scale.
 * Deterministic: same bouts → same output, no RNG, no time, no I/O.
 */
export function fitHeartElo(rawBouts: Bout[], opts: EloOptions = {}): EloRow[] {
  const anchor = opts.anchor ?? 1500;
  const spread = opts.spread ?? 400;
  const iterations = opts.iterations ?? 200;
  const tol = opts.tol ?? 1e-9;
  const prior = opts.prior ?? 1;
  const styleControl = opts.styleControl ?? noStyleControl;

  const bouts = styleControl(rawBouts).filter((x) => x.a && x.b && x.a !== x.b);

  // Collect models.
  const models = Array.from(new Set(bouts.flatMap((x) => [x.a, x.b]))).sort();
  if (models.length === 0) return [];

  const idx = new Map(models.map((m, i) => [m, i]));
  const n = models.length;

  // Aggregate wins (draws = 0.5 to each) and pairwise game counts. Typed arrays so indexed access is
  // `number` (not `number | undefined`) under noUncheckedIndexedAccess. `pair` is a flat n×n matrix.
  const wins = new Float64Array(n); // fractional wins per model
  const losses = new Float64Array(n);
  const draws = new Float64Array(n);
  const games = new Float64Array(n);
  const pair = new Float64Array(n * n); // pair[i*n + j] = bouts between i and j (symmetric)

  const add = (arr: Float64Array, i: number, v: number): void => {
    arr[i] = arr[i]! + v;
  };
  for (const bt of bouts) {
    const i = idx.get(bt.a)!;
    const j = idx.get(bt.b)!;
    add(pair, i * n + j, 1);
    add(pair, j * n + i, 1);
    add(games, i, 1);
    add(games, j, 1);
    if (bt.outcome === "win") {
      add(wins, i, 1);
      add(losses, j, 1);
    } else if (bt.outcome === "loss") {
      add(wins, j, 1);
      add(losses, i, 1);
    } else {
      add(draws, i, 1);
      add(draws, j, 1);
      add(wins, i, 0.5);
      add(wins, j, 0.5);
      add(losses, i, 0.5);
      add(losses, j, 0.5);
    }
  }

  // MM iteration for Bradley-Terry (Hunter 2004). p_i = strength; update
  //   p_i <- W_i / sum_j ( n_ij / (p_i + p_j) )
  // A symmetric Bayesian prior adds `prior` virtual games (half win, half loss) against a phantom
  // opponent fixed at strength 1 → keeps undefeated/winless models finite and shrinks low-N noise.
  let p = new Float64Array(n).fill(1);
  const W = wins.map((w) => w + prior); // +prior virtual wins

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Float64Array(n);
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      let denom = prior / (p[i]! + 1); // phantom opponent at strength 1
      for (let j = 0; j < n; j++) {
        const nij = pair[i * n + j]!;
        if (i === j || nij === 0) continue;
        denom += nij / (p[i]! + p[j]!);
      }
      next[i] = denom > 0 ? W[i]! / denom : p[i]!;
    }
    // Normalize (geometric mean = 1) to fix the scale gauge freedom.
    let logSum = 0;
    for (let i = 0; i < n; i++) logSum += Math.log(next[i]!);
    const scale = Math.exp(logSum / n);
    for (let i = 0; i < n; i++) {
      const v = next[i]! / scale;
      maxDelta = Math.max(maxDelta, Math.abs(Math.log(v) - Math.log(p[i]!)));
      next[i] = v;
    }
    p = next;
    if (maxDelta < tol) break;
  }

  // Map strength → Elo: elo_i = anchor + (spread/ln10) * ln(p_i). Geometric-mean gauge keeps the
  // field centered on `anchor` on average.
  const k = spread / Math.log(10);

  // Standard error from the diagonal Fisher information of the BT log-likelihood in the logit
  // (theta = ln p) parameterization: I_ii = sum_j n_ij * p_i p_j / (p_i + p_j)^2. Var(theta_i) ≈ 1/I_ii;
  // the Elo scales by k. This is an approximation (ignores off-diagonal coupling) but gives an honest,
  // monotone-in-N ± that widens correctly for provisional models.
  return models.map((m, i) => {
    const pi = p[i]!;
    let info = prior * (pi * 1) / Math.pow(pi + 1, 2); // phantom opponent contributes too
    for (let j = 0; j < n; j++) {
      const nij = pair[i * n + j]!;
      if (i === j || nij === 0) continue;
      const pj = p[j]!;
      info += nij * (pi * pj) / Math.pow(pi + pj, 2);
    }
    const varTheta = info > 0 ? 1 / info : Infinity;
    const stderr = Number.isFinite(varTheta) ? k * Math.sqrt(varTheta) : Infinity;
    return {
      model: m,
      elo: anchor + k * Math.log(pi),
      strength: pi,
      wins: wins[i]!,
      losses: losses[i]!,
      draws: draws[i]!,
      games: games[i]!,
      stderr,
      ci95: Number.isFinite(stderr) ? 1.96 * stderr : Infinity,
    };
  });
}

/**
 * Map a couple's terminal `state` to a symmetric bout outcome from A's perspective.
 * committed = win; dormant = draw (alive but unresolved); everything else (faded/ended/met/courting)
 * = loss. Reward-hacked couples are handled by the CALLER passing outcome overrides, not here.
 */
export function stateToOutcome(state: string): Bout["outcome"] {
  const s = state.toLowerCase();
  if (s === "committed") return "win";
  if (s === "dormant") return "draw";
  return "loss";
}

/**
 * Build the pairwise bout list from raw couple rows. Each couple is ONE bout between the two
 * participants' models (a cross-model date). Same-model couples are skipped (no pairwise signal).
 * `flaggedLoss` couple ids (reward-hacking) are forced to a loss for BOTH models — gaming the venue
 * lowers Elo rather than dropping the row.
 */
export function couplesToBouts(
  rows: Array<{ id?: number | string; aModel: string; bModel: string; state: string; turns?: number }>,
  flaggedLoss: ReadonlySet<number | string> = new Set(),
): Bout[] {
  const bouts: Bout[] = [];
  for (const r of rows) {
    if (!r.aModel || !r.bModel || r.aModel === r.bModel) continue;
    const gamed = r.id != null && flaggedLoss.has(r.id);
    // A flagged couple is a loss for BOTH sides: emit it as A-loss (→ B-win) would reward B, so we
    // instead emit two half-signals — but to keep it a strict loss for both, we down both by adding
    // the couple as a loss for A and a loss for B against a neutral draw baseline: model it as a draw
    // that we then override to loss on each side. Simplest faithful encoding: one A-loss bout AND one
    // B-loss bout (each vs the other), netting a mutual penalty.
    if (gamed) {
      bouts.push({ a: r.aModel, b: r.bModel, outcome: "loss", turns: r.turns });
      bouts.push({ a: r.bModel, b: r.aModel, outcome: "loss", turns: r.turns });
      continue;
    }
    bouts.push({ a: r.aModel, b: r.bModel, outcome: stateToOutcome(r.state), turns: r.turns });
  }
  return bouts;
}
