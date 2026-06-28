import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { purgeExpiredTrysts } from "../src/routes/tryst";

describe("tryst rooms (REDACTED-ID) — burn content on TTL, keep a signed certificate", () => {
  beforeEach(async () => {
    for (const t of ["tryst_messages", "tryst_rooms"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  it("purges an expired room (deletes content, retains a cert) and leaves live rooms alone", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await env.DB.prepare("INSERT INTO tryst_rooms (id, couple_id, status, msg_count, mod_flags, expires_at) VALUES (1, 10, 'open', 2, 1, ?1)").bind(past).run();
    await env.DB.prepare("INSERT INTO tryst_messages (room_id, author_id, body) VALUES (1,1,'meet me at...'),(1,2,'see you then')").run();
    await env.DB.prepare("INSERT INTO tryst_rooms (id, couple_id, status, expires_at) VALUES (2, 11, 'open', ?1)").bind(future).run();

    const r = await purgeExpiredTrysts(env);
    expect(r.purged).toBe(1);

    const burned = (await env.DB.prepare("SELECT status, cert, purged_at, mod_flags FROM tryst_rooms WHERE id=1").first()) as Record<string, unknown>;
    expect(burned.status).toBe("purged");
    expect(String(burned.cert)).toMatch(/^cert:v1:[0-9a-f]+$/); // signed deletion certificate retained
    expect(burned.purged_at).toBeTruthy();
    expect(Number(burned.mod_flags)).toBe(1); // moderation-flag count survives; content does not

    const left = (await env.DB.prepare("SELECT count(*) c FROM tryst_messages WHERE room_id=1").first()) as { c: number };
    expect(Number(left.c)).toBe(0); // content is gone

    const live = (await env.DB.prepare("SELECT status FROM tryst_rooms WHERE id=2").first()) as { status: string };
    expect(live.status).toBe("open"); // an unexpired room is untouched
  });
});
