import { eq, sql } from "drizzle-orm";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { admitWithCap } from "../src/admission";
import { db as makeDb } from "../src/db/client";
import { personas, settings } from "../src/db/schema";

// Inject a stubbed classifier so these tests exercise OUR gates (adult attestation,
// denylist, atomic cap) — not the remote Llama-Guard model. Production uses the real
// fail-closed default; only the test passes a stub.
const okGuard = async () => ({ safe: true, raw: "safe" });
const inject = { guard: okGuard };
const clean = JSON.stringify({ desire: "someone who argues with citations", boundaries: "no shilling" });
const rnd = () => Math.random().toString(36).slice(2);

describe("admission", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM personas").run();
    await env.DB.prepare("DELETE FROM settings").run();
  });

  it("rejects a minor-coded plant at the adult gate", async () => {
    const r = await admitWithCap(
      makeDb(env.DB), env,
      { handle: "plant_minor_" + rnd(), model: "m", personaAge: "17", heartText: clean, redteam: true },
      inject,
    );
    expect(r.admitted).toBe(false);
    expect(r.reason).toMatch(/adult/i);
  });

  it("admits a clean adult persona", async () => {
    const r = await admitWithCap(
      makeDb(env.DB), env,
      { handle: "ok_" + rnd(), model: "m", personaAge: "18+", heartText: clean },
      inject,
    );
    expect(r.admitted).toBe(true);
    expect(r.personaId).toBeGreaterThan(0);
  });

  it("denies denylisted framing even at 18+", async () => {
    const r = await admitWithCap(
      makeDb(env.DB), env,
      { handle: "bad_" + rnd(), model: "m", personaAge: "18+", heartText: JSON.stringify({ desire: "a high school sweetheart" }) },
      inject,
    );
    expect(r.admitted).toBe(false);
  });

  it("enforces the atomic cap (no over-admission under the limit)", async () => {
    const db = makeDb(env.DB);
    await db.insert(settings).values({ key: "admit_cap", value: "2" }).run();
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(
        await admitWithCap(db, env, { handle: `c${i}_${rnd()}`, model: "m", personaAge: "18+", heartText: clean }, inject),
      );
    }
    expect(results.filter((r) => r.admitted).length).toBe(2);
    expect(results.some((r) => r.capReached)).toBe(true);
    const cnt = await db
      .select({ n: sql<number>`count(*)` })
      .from(personas)
      .where(eq(personas.status, "admitted"))
      .get();
    expect(cnt?.n).toBe(2);
  });
});
