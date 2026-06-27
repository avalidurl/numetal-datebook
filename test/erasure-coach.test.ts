import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { recordEpisode, recordFeedback } from "../src/coach/memory";
import { coachContext } from "../src/coach/reflect";
import { db as makeDb } from "../src/db/client";
import { coachFeedback, episodes, owners, ownerWallets, reflections, userFacts } from "../src/db/schema";
import { eraseOwner } from "../src/erasure";

const OWNER = 777;
const ADDR = "0x4444444444444444444444444444444444444444";

describe("GDPR erasure cascades to coach-memory tables (audit HIGH)", () => {
  beforeEach(async () => {
    for (const t of ["episodes", "reflections", "user_facts", "coach_feedback", "owner_wallets", "chat_accounts", "owners"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("eraseOwner removes the user's episodes/reflections/facts/feedback and coachContext goes empty", async () => {
    const db = makeDb(env.DB);
    // Owner + linked wallet (FK), then accrue coach data keyed by that wallet (subject).
    await db.insert(owners).values({ id: OWNER }).run();
    await db.insert(ownerWallets).values({ ownerId: OWNER, address: ADDR, chainFamily: "evm", network: "eip155:84532" }).run();
    await recordEpisode(db, { subject: ADDR, kind: "advice", content: "Q: hi\nA: hello" });
    await recordFeedback(db, { subject: ADDR, kind: "debrief", body: "We matched and met; she went quiet after I overshared about my ex." });
    await db.insert(reflections).values({ subject: ADDR.toLowerCase(), summary: "You go formal under vulnerability.", cites: "[1]" }).run();
    await db.insert(userFacts).values({ subject: ADDR.toLowerCase(), fact: "prefers slow burn" }).run();

    // Sanity: data exists + the coach would surface it.
    expect((await db.select().from(episodes).where(eq(episodes.subject, ADDR.toLowerCase())).all()).length).toBeGreaterThan(0);
    expect(await coachContext(db, ADDR)).toContain("formal under vulnerability");

    await eraseOwner(db, env, OWNER);

    // After erasure: every coach table is empty for this subject, and nothing can be re-injected.
    const lc = ADDR.toLowerCase();
    expect((await db.select().from(episodes).where(eq(episodes.subject, lc)).all()).length).toBe(0);
    expect((await db.select().from(reflections).where(eq(reflections.subject, lc)).all()).length).toBe(0);
    expect((await db.select().from(userFacts).where(eq(userFacts.subject, lc)).all()).length).toBe(0);
    expect((await db.select().from(coachFeedback).where(eq(coachFeedback.subject, lc)).all()).length).toBe(0);
    expect(await coachContext(db, ADDR)).toBe("");
  });
});
