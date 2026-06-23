import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { coachContext, loadEpisodesForReflection, runReflectionSweep } from "../src/coach/reflect";
import { recordEpisode } from "../src/coach/memory";
import { db as makeDb } from "../src/db/client";
import { reflections } from "../src/db/schema";

const A = "0x3333333333333333333333333333333333333333";

describe("reflection job (Phase 2)", () => {
  beforeEach(async () => {
    for (const t of ["reflections", "episodes"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  it("loadEpisodesForReflection orders by importance, then recency", async () => {
    const db = makeDb(env.DB);
    await recordEpisode(db, { subject: A, kind: "advice", content: "low-1", importance: 0.2 });
    await recordEpisode(db, { subject: A, kind: "advice", content: "low-2", importance: 0.2 });
    await recordEpisode(db, { subject: A, kind: "debrief", content: "high", importance: 0.9 });
    const eps = await loadEpisodesForReflection(db, A, 10);
    expect(eps[0]!.content).toBe("high"); // highest importance first
    expect(eps.length).toBe(3);
  });

  it("coachContext is empty until a reflection exists, then returns the lovemap", async () => {
    const db = makeDb(env.DB);
    expect(await coachContext(db, A)).toBe("");
    await db.insert(reflections).values({ subject: A, summary: "You open warm but go formal when someone gets vulnerable.", cites: "[1,2]" }).run();
    const ctx = await coachContext(db, A);
    expect(ctx).toContain("go formal when someone gets vulnerable");
    expect(ctx).toContain("never quote episode ids"); // injection guardrail present
  });

  it("runReflectionSweep flags subjects with >=3 episodes and no fresh reflection as due", async () => {
    const db = makeDb(env.DB);
    for (let i = 0; i < 3; i++) await recordEpisode(db, { subject: A, kind: "advice", content: `e${i}`, importance: 0.5 });
    // model is unavailable in the test runtime, so processing fails-soft; `due` must still detect the subject.
    const r = await runReflectionSweep(db, env, 10);
    expect(r.due).toBe(1);
  });
});
