import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { seal } from "../src/crypto/box";
import { signRelayBody } from "../src/agentrelay/outbound";
import { notifyMatchForCouple } from "../src/notify/match-hook";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const WEBHOOK = "https://agent.example.com/ishtar-hook";
const SECRET = "a-long-shared-delivery-secret-123";

function testEnv(over: Partial<Env> = {}): Env {
  return { DB: env.DB, ENCRYPTION_KEY: KEY, PUBLIC_SITE_URL: "https://ishtar.numetal.xyz", ...over } as unknown as Env;
}
async function agentOwner(): Promise<number> {
  // agent_represented owner: NO featured post, alert_channels='agent-relay', no email contactRef.
  const r = await env.DB.prepare(
    "INSERT INTO owners (display_name, alert_channels, tier, status) VALUES ('AgentDater', 'agent-relay', 'agent_represented', 'admitted') RETURNING id",
  ).first<{ id: number }>();
  return r!.id;
}
async function plainOwner(): Promise<number> {
  const r = await env.DB.prepare("INSERT INTO owners (display_name, status) VALUES ('Other', 'admitted') RETURNING id").first<{ id: number }>();
  return r!.id;
}
async function persona(ownerId: number, handle: string): Promise<number> {
  const r = await env.DB.prepare(
    "INSERT INTO personas (owner_id, handle, model, heart_json, persona_age, status, home_market, active_market, redteam) VALUES (?1,?2,'m','{}','18+','admitted','other','remote',0) RETURNING id",
  ).bind(ownerId, handle).first<{ id: number }>();
  return r!.id;
}
async function couple(aId: number, bId: number): Promise<number> {
  const r = await env.DB.prepare(
    "INSERT INTO couples (cycle_id, a_id, b_id, state, lane, turn_count) VALUES ('t',?1,?2,'met','public',0) RETURNING id",
  ).bind(aId, bId).first<{ id: number }>();
  return r!.id;
}
async function seedDelivery(ownerId: number, e: Env): Promise<void> {
  await env.DB.prepare("INSERT INTO owner_deliveries (owner_id, url, secret, status) VALUES (?1, ?2, ?3, 'active')")
    .bind(ownerId, await seal(e, WEBHOOK), await seal(e, SECRET))
    .run();
}

beforeEach(async () => {
  for (const t of ["notifications", "owner_deliveries", "couples", "personas", "featured_posts", "owners"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});
afterEach(() => vi.restoreAllMocks());

describe("match-hook now reaches the AGENT-SERVED tier (owner_deliveries), not just enrolled humans", () => {
  it("with AGENT_RELAY_ENABLED: an agent_represented owner with a webhook (no featured post) gets a SIGNED push", async () => {
    const e = testEnv({ AGENT_RELAY_ENABLED: "1" });
    const a = await agentOwner();
    const b = await plainOwner();
    await seedDelivery(a, e);
    const cid = await couple(await persona(a, "a"), await persona(b, "b"));

    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }));

    await notifyMatchForCouple(e, cid);

    // The venue POSTed the come-look to the agent's webhook (targeting the agent owner, no featured post).
    const push = calls.find((c) => c.url === WEBHOOK);
    expect(push, "venue should POST to the agent's delivery webhook").toBeTruthy();
    expect(push!.init.method).toBe("POST");
    const headers = push!.init.headers as Record<string, string>;
    const body = push!.init.body as string;
    // The signature is a valid HMAC over the exact body → a consumer can verify it.
    const expected = `sha256=${await signRelayBody(SECRET, body)}`;
    expect(headers["x-ishtar-signature"]).toBe(expected);
    // Payload is the come-look magic-link only — no PII/contact.
    const payload = JSON.parse(body) as { kind: string; ownerId: number; url: string };
    expect(payload.kind).toBe("match");
    expect(payload.ownerId).toBe(a);
    expect(payload.url).toContain("/matches/?token=");
    expect(body).not.toContain(SECRET);
  });

  it("flag gates only the SEND: with AGENT_RELAY_ENABLED unset, the agent owner is still TARGETED (no push fires)", async () => {
    const e = testEnv(); // flag off
    const a = await agentOwner();
    const b = await plainOwner();
    await seedDelivery(a, e);
    const cid = await couple(await persona(a, "a2"), await persona(b, "b2"));

    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await notifyMatchForCouple(e, cid);

    // No push while the flag is off...
    expect(fetchMock).not.toHaveBeenCalledWith(WEBHOOK, expect.anything());
    // ...but the hook DID target the agent owner: a notifications row was claimed for agent-relay.
    const row = await env.DB.prepare(
      "SELECT status, reason FROM notifications WHERE owner_id=?1 AND kind='match' AND ref=?2 AND channel='agent-relay'",
    ).bind(a, String(cid)).first<{ status: string; reason: string | null }>();
    expect(row, "the agent owner should be targeted even with push disabled").toBeTruthy();
    expect(row!.status).not.toBe("sent"); // channel not ready (flag off) → skipped, not delivered
  });
});
