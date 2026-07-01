import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import worker from "../src/index";
import { db as makeDb } from "../src/db/client";
import { couples, owners, personas, reports } from "../src/db/schema";

// The console is served only on the admin.* host (CF-Access-gated in prod); target it so the
// host-lock redirect doesn't intercept the gate-behaviour these tests assert.
const req = (path: string, key?: string) =>
  new Request(`https://admin.ishtar.numetal.xyz${path}`, {
    headers: { host: "admin.ishtar.numetal.xyz", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    cf: { country: "US" },
  });

describe("admin single-pane dashboard", () => {
  it("serves /admin.json snapshot when authed", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(req("/admin.json", "test-key"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j.health).toBe("ok");
    expect(j).toHaveProperty("admitted");
    expect(j).toHaveProperty("daily_budget_usd");
    expect(j).toHaveProperty("budget_remaining_usd");
    expect(j).toHaveProperty("revenue_usdc");
  });

  it("blocks the dashboard without the access key", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(req("/admin.json"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(403);
  });

  it("SEC#9: freezing a reported persona also ends its active couple (leaves the public floor)", async () => {
    const db = makeDb(env.DB);
    const rnd = () => Math.random().toString(36).slice(2);
    const o = await db.insert(owners).values({ displayName: "rep", tier: "agent_represented" }).returning({ id: owners.id }).get();
    const pa = await db.insert(personas).values({ ownerId: o.id, handle: "pa_" + rnd(), model: "m", heartJson: "{}", personaAge: "18+", status: "admitted" }).returning({ id: personas.id }).get();
    const pb = await db.insert(personas).values({ ownerId: o.id, handle: "pb_" + rnd(), model: "m", heartJson: "{}", personaAge: "18+", status: "admitted" }).returning({ id: personas.id }).get();
    const couple = await db.insert(couples).values({ cycleId: "t", aId: pa.id, bId: pb.id, state: "courting" }).returning({ id: couples.id }).get();
    const rep = await db.insert(reports).values({ targetType: "persona", targetId: pa.id, reason: "test", status: "open" }).returning({ id: reports.id }).get();

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://admin.ishtar.numetal.xyz/admin/actions/report", {
        method: "POST",
        headers: { host: "admin.ishtar.numetal.xyz", authorization: "Bearer test-key", "content-type": "application/json" },
        cf: { country: "US" },
        body: JSON.stringify({ reportId: rep.id, action: "freeze" }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);

    const frozen = await db.select().from(personas).where(eq(personas.id, pa.id)).get();
    expect(frozen?.status).toBe("frozen"); // persona frozen
    const c = await db.select().from(couples).where(eq(couples.id, couple.id)).get();
    expect(c?.state).toBe("ended"); // couple ENDED (pre-fix: stayed 'courting' and kept publishing)
  });
});
