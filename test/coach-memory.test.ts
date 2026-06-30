import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { recordEpisode, recordFeedback } from "../src/coach/memory";
import { db as makeDb } from "../src/db/client";
import { chatAccounts, episodes } from "../src/db/schema";

const ADDR = "0x2222222222222222222222222222222222222222";

describe("coach memory — Phase 0 capture + feedback→discount", () => {
  beforeEach(async () => {
    for (const t of ["coach_feedback", "episodes", "chat_accounts"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  it("recordEpisode appends a typed, importance-clamped episode", async () => {
    const db = makeDb(env.DB);
    await recordEpisode(db, env, { subject: ADDR, kind: "advice", content: "Q: hi\nA: hello", importance: 9 });
    const eps = await db.select().from(episodes).where(eq(episodes.subject, ADDR)).all();
    expect(eps.length).toBe(1);
    expect(eps[0]!.kind).toBe("advice");
    expect(eps[0]!.importance).toBe(1); // clamped to 0..1
  });

  it("a debrief awards 10 credits + mints a high-signal episode, single-credit per day", async () => {
    const db = makeDb(env.DB);
    const r1 = await recordFeedback(db, env, { subject: ADDR, kind: "debrief", body: "We matched and met for coffee; she went quiet after I overshared." });
    expect(r1.awarded).toBe(10);
    const eps = await db.select().from(episodes).where(eq(episodes.subject, ADDR)).all();
    expect(eps.some((e) => e.kind === "debrief" && e.importance === 0.9 && e.source === "feedback")).toBe(true);
    const acct = await db.select().from(chatAccounts).where(eq(chatAccounts.address, ADDR)).get();
    expect(acct?.credits).toBe(10);
    // second debrief same day → stored but no double credit
    const r2 = await recordFeedback(db, env, { subject: ADDR, kind: "debrief", body: "Second date went better, three hours talking about travel and books." });
    expect(r2.awarded).toBe(0);
  });

  it("ratings award 2 and the daily cap holds at 12", async () => {
    const db = makeDb(env.DB);
    expect((await recordFeedback(db, env, { subject: ADDR, kind: "rating", rating: 5 })).awarded).toBe(2);
    expect((await recordFeedback(db, env, { subject: ADDR, kind: "debrief", body: "A debrief with at least forty characters of genuine content right here." })).awarded).toBe(10);
    const acct = await db.select().from(chatAccounts).where(eq(chatAccounts.address, ADDR)).get();
    expect(acct?.credits).toBe(12); // 2 + 10 = daily cap
  });
});
