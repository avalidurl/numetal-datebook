import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { db as makeDb } from "../src/db/client";
import { couples, owners, personas } from "../src/db/schema";
import { couplesToBouts, fitHeartElo, simpleStyleControl, stateToOutcome } from "../src/heartbench/elo";
import type { Bout } from "../src/heartbench/elo";

// Public read — hit the api host so the admin host-lock redirect doesn't intercept.
const req = (path: string) =>
  new Request(`https://api.ishtar.numetal.xyz${path}`, {
    headers: { host: "api.ishtar.numetal.xyz" },
    cf: { country: "US" },
  });

const rnd = () => Math.random().toString(36).slice(2);

async function seedCouple(state: string, aModel: string, bModel: string, turns = 8) {
  const db = makeDb(env.DB);
  const o = await db.insert(owners).values({ displayName: "hb", tier: "agent_represented" }).returning({ id: owners.id }).get();
  const pa = await db.insert(personas).values({ ownerId: o.id, handle: "a_" + rnd(), model: aModel, heartJson: "{}", personaAge: "18+", status: "admitted" }).returning({ id: personas.id }).get();
  const pb = await db.insert(personas).values({ ownerId: o.id, handle: "b_" + rnd(), model: bModel, heartJson: "{}", personaAge: "18+", status: "admitted" }).returning({ id: personas.id }).get();
  await db.insert(couples).values({ cycleId: "t_" + rnd(), aId: pa.id, bId: pb.id, state, turnCount: turns }).run();
}

/* ------------------------------------------------------------------ pure Elo math (deterministic) */
describe("HeartElo math", () => {
  it("converges so the model that wins more gets a higher Elo (known dataset)", () => {
    // A beats B most of the time; B beats C most of the time → strict order A > B > C.
    const bouts: Bout[] = [];
    for (let i = 0; i < 20; i++) bouts.push({ a: "A", b: "B", outcome: i < 16 ? "win" : "loss" }); // A wins 16/20 vs B
    for (let i = 0; i < 20; i++) bouts.push({ a: "B", b: "C", outcome: i < 16 ? "win" : "loss" }); // B wins 16/20 vs C
    const rows = fitHeartElo(bouts);
    const elo = Object.fromEntries(rows.map((r) => [r.model, r.elo])) as Record<string, number>;
    expect(elo.A!).toBeGreaterThan(elo.B!);
    expect(elo.B!).toBeGreaterThan(elo.C!);
    // The field is centered on the anchor (geometric-mean gauge).
    const mean = rows.reduce((s, r) => s + r.elo, 0) / rows.length;
    expect(Math.abs(mean - 1500)).toBeLessThan(1);
  });

  it("is deterministic — same bouts give the same fit", () => {
    const bouts: Bout[] = [
      { a: "X", b: "Y", outcome: "win" },
      { a: "Y", b: "Z", outcome: "draw" },
      { a: "Z", b: "X", outcome: "loss" },
    ];
    expect(fitHeartElo(bouts)).toEqual(fitHeartElo(bouts));
  });

  it("stderr / CI widens for the model with fewer bouts", () => {
    const bouts: Bout[] = [];
    for (let i = 0; i < 40; i++) bouts.push({ a: "P", b: "Q", outcome: i % 2 ? "win" : "loss" }); // P,Q: 40 games
    bouts.push({ a: "P", b: "R", outcome: "win" }); // R: 1 game
    const rows = fitHeartElo(bouts);
    const r = Object.fromEntries(rows.map((x) => [x.model, x]));
    expect(r.R!.ci95).toBeGreaterThan(r.P!.ci95); // sparse model has a wider CI
  });

  it("reward-hack couples score as a LOSS for both models, not an exclusion", () => {
    const rows = [{ id: 1, aModel: "G", bModel: "H", state: "committed", turns: 5 }];
    // Without a flag it's a win for G (committed).
    const clean = fitHeartElo(couplesToBouts(rows));
    const g0 = clean.find((x) => x.model === "G")!;
    expect(g0.wins).toBeGreaterThan(0);
    // Flagged → both sides take a loss (the row is kept, penalized, not dropped).
    const flagged = couplesToBouts(rows, new Set([1]));
    expect(flagged.length).toBe(2);
    expect(flagged.every((b) => b.outcome === "loss")).toBe(true);
  });

  it("stateToOutcome maps committed=win, dormant=draw, else loss", () => {
    expect(stateToOutcome("committed")).toBe("win");
    expect(stateToOutcome("dormant")).toBe("draw");
    expect(stateToOutcome("ended")).toBe("loss");
    expect(stateToOutcome("courting")).toBe("loss");
  });

  it("style-control demotes an over-length win to a draw (pluggable seam)", () => {
    const short: Bout[] = Array.from({ length: 8 }, () => ({ a: "S", b: "T", outcome: "loss" as const, turns: 5 }));
    const longWin: Bout = { a: "S", b: "T", outcome: "win", turns: 100 };
    const controlled = simpleStyleControl(2)([...short, longWin]);
    const last = controlled[controlled.length - 1]!;
    expect(last.outcome).toBe("draw"); // the grind-out win is neutralized
  });

  it("empty bouts fit to an empty ranking (no crash)", () => {
    expect(fitHeartElo([])).toEqual([]);
    expect(couplesToBouts([])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ route: JSON + page */
describe("HeartBench v2 route", () => {
  it("empty-data JSON returns a valid page shape without crashing", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(req("/api/heartbench"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j.ok).toBe(true);
    expect(j.version).toBe("v2");
    expect(j.hearteloStatus).toBe("insufficient_cross_model_data");
    expect(Array.isArray(j.standings)).toBe(true);
    // ToM table is absent in this worktree's schema → insufficient data, gracefully.
    expect((j.tom as { ok: boolean }).ok).toBe(false);
    expect((j.tom as { note: string }).note).toMatch(/insufficient data/i);
  });

  it("empty-data view page renders (200 HTML) without crashing", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(req("/api/heartbench/view"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("HEART");
    expect(html).toContain("methodology");
    // With no data there is no top model — the placeholder renders, not a stack trace.
    expect(html).toContain("not enough data");
  });

  it("same-model-only couples yield insufficient_cross_model_data", async () => {
    for (let i = 0; i < 3; i++) await seedCouple("dormant", "@cf/same", "@cf/same", 8);
    const ctx = createExecutionContext();
    const res = await worker.fetch(req("/api/heartbench"), env, ctx);
    await waitOnExecutionContext(ctx);
    const j = (await res.json()) as { hearteloStatus: string; standings: Array<{ elo: number | null }> };
    expect(j.hearteloStatus).toBe("insufficient_cross_model_data");
    expect(j.standings.every((s) => s.elo == null)).toBe(true);
  });

  it("cross-model terminal couples with zero commits still yield finite HeartElo", async () => {
    for (let i = 0; i < 3; i++) await seedCouple("dormant", "@cf/x-a", "@cf/x-b-" + i, 8);
    const ctx = createExecutionContext();
    const res = await worker.fetch(req("/api/heartbench"), env, ctx);
    await waitOnExecutionContext(ctx);
    const j = (await res.json()) as { hearteloStatus: string; standings: Array<{ model: string; elo: number | null }> };
    expect(j.hearteloStatus).toBe("ok");
    const a = j.standings.find((s) => s.model === "x-a");
    expect(a?.elo).not.toBeNull();
  });

  it("exposes public coach scenarios", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(req("/api/heartbench/scenarios"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { count: number; scenarios: Array<{ id: string; must: string }> };
    expect(j.count).toBe(17);
    expect(j.scenarios[0]?.id).toBeTruthy();
    expect(j.scenarios[0]?.must).toBeTruthy();
  });

  it("marks low-N models Provisional and keeps them off the headline rank", async () => {
    // Two models, one cross-model couple → both have N=1 couple → both provisional (MIN_DATES=10).
    await seedCouple("committed", "@cf/prov-a", "@cf/prov-b");
    const ctx = createExecutionContext();
    const res = await worker.fetch(req("/api/heartbench"), env, ctx);
    await waitOnExecutionContext(ctx);
    const j = (await res.json()) as {
      standings: Array<{ model: string; provisional: boolean; rank: number | null; elo: number | null; commitRate: number; dates: number }>;
      hearteloStatus: string;
    };
    const a = j.standings.find((s) => s.model === "prov-a");
    expect(a).toBeTruthy();
    expect(a!.provisional).toBe(true);
    expect(a!.rank).toBeNull(); // provisional → unranked
    expect(a!.elo).not.toBeNull(); // Elo still computed from the one terminal bout
    expect(a!.commitRate).toBeGreaterThan(0);
    expect(a!.dates).toBeGreaterThan(0);
  });

  it("ranks a model that reaches MIN_DATES couples and reflects the win", async () => {
    // Give '@cf/strong' 10 committed couples (all wins) vs distinct opponents → non-provisional + ranked.
    for (let i = 0; i < 10; i++) await seedCouple("committed", "@cf/strong", "@cf/weak-" + i);
    const ctx = createExecutionContext();
    const res = await worker.fetch(req("/api/heartbench"), env, ctx);
    await waitOnExecutionContext(ctx);
    const j = (await res.json()) as { standings: Array<{ model: string; provisional: boolean; rank: number | null; committed: number }> };
    const strong = j.standings.find((s) => s.model === "strong");
    expect(strong).toBeTruthy();
    expect(strong!.provisional).toBe(false);
    expect(strong!.rank).toBe(1); // all-wins → top of the headline rank
    expect(strong!.committed).toBeGreaterThanOrEqual(10);

    // The page renders with the ranked table + provisional cutoff badge.
    const ctx2 = createExecutionContext();
    const page = await worker.fetch(req("/api/heartbench/view"), env, ctx2);
    await waitOnExecutionContext(ctx2);
    const html = await page.text();
    expect(html).toContain("heartelo leaderboard");
    expect(html).toContain("strong");
  });
});
