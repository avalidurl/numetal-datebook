import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { seal } from "../src/crypto/box";
import {
  channelRegistry,
  enabledChannels,
  getChannel,
  matchAlertEmail,
  mintMatchToken,
  notifyOwner,
  verifyMatchToken,
} from "../src/notify/dispatch";
import { notifyMatchForCouple } from "../src/notify/match-hook";

// A deterministic 32-byte AES key so seal()/open() round-trip and the token HMAC has a key.
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

/** The notify Env: the real test D1 + the notify config (Resend on, encryption on, a site URL). */
function notifyEnv(over: Partial<Env> = {}): Env {
  return {
    DB: env.DB,
    RESEND_API_KEY: "re_test",
    NEWSLETTER_FROM: "Ishtar <ishtar@numetal.xyz>",
    ENCRYPTION_KEY: KEY,
    PUBLIC_SITE_URL: "https://ishtar.numetal.xyz",
    ...over,
  } as unknown as Env;
}

/** Seed an owner with a sealed email contact; returns the new owner id. */
async function makeOwner(email: string | null, alertChannels = "email"): Promise<number> {
  const sealed = email ? await seal(notifyEnv(), `email:${email}`) : null;
  const r = await env.DB.prepare(
    "INSERT INTO owners (display_name, contact_ref, alert_channels, status) VALUES (?1, ?2, ?3, 'admitted') RETURNING id",
  )
    .bind("Dater", sealed, alertChannels)
    .first<{ id: number }>();
  return r!.id;
}

/** Seed a persona for an owner; returns the persona id. */
async function makePersona(ownerId: number, handle: string): Promise<number> {
  const r = await env.DB.prepare(
    "INSERT INTO personas (owner_id, handle, model, heart_json, persona_age, status, home_market, active_market, redteam) VALUES (?1, ?2, 'm', '{}', '18+', 'admitted', 'other', 'remote', 0) RETURNING id",
  )
    .bind(ownerId, handle)
    .first<{ id: number }>();
  return r!.id;
}

/** Seed a couple between two personas; returns the couple id. */
async function makeCouple(aId: number, bId: number, cycle = "t"): Promise<number> {
  const r = await env.DB.prepare(
    "INSERT INTO couples (cycle_id, a_id, b_id, state, lane, turn_count) VALUES (?1, ?2, ?3, 'met', 'public', 0) RETURNING id",
  )
    .bind(cycle, aId, bId)
    .first<{ id: number }>();
  return r!.id;
}

/** Mimic the sibling enrol branch: add featured_posts.owner_id (idempotent for the isolate). */
async function addFeaturedOwnerIdColumn(): Promise<void> {
  const cols = (await env.DB.prepare("PRAGMA table_info(featured_posts)").all()).results as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "owner_id")) {
    await env.DB.prepare("ALTER TABLE featured_posts ADD COLUMN owner_id INTEGER").run();
  }
}

/** Enrol an owner as a featured human (the shared-contract linkage). */
async function enrolFeaturedHuman(ownerId: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO featured_posts (author_kind, public_summary, order_id, status, owner_id) VALUES ('human', 'a public blurb', ?1, 'live', ?2)",
  )
    .bind(`order-${ownerId}-${Math.random().toString(36).slice(2)}`, ownerId)
    .run();
}

beforeEach(async () => {
  for (const t of ["notifications", "turns", "couples", "personas", "featured_posts", "owners"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});
afterEach(() => vi.restoreAllMocks());

describe("match-token (HMAC, expiring)", () => {
  it("mint → verify round-trips the ownerId", async () => {
    const e = notifyEnv();
    const token = await mintMatchToken(e, 4242);
    expect(token.startsWith("v1.")).toBe(true);
    expect(token.split(".")).toHaveLength(3);
    const v = await verifyMatchToken(e, token);
    expect(v?.ownerId).toBe(4242);
  });

  it("rejects a tampered body and a wrong key", async () => {
    const e = notifyEnv();
    const token = await mintMatchToken(e, 7);
    const [, body, sig] = token.split(".");
    // Tamper the body → signature no longer matches.
    expect(await verifyMatchToken(e, `v1.${body}x.${sig}`)).toBeNull();
    // A different signing key → reject.
    const other = notifyEnv({ ENCRYPTION_KEY: undefined, NOTIFY_TOKEN_SECRET: "another-secret" });
    expect(await verifyMatchToken(other, token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const e = notifyEnv();
    const token = await mintMatchToken(e, 9, -10); // already expired (negative TTL)
    expect(await verifyMatchToken(e, token)).toBeNull();
  });
});

describe("channel registry", () => {
  it("exposes email plus the five stubs, and resolves by name", () => {
    expect(getChannel("email")?.name).toBe("email");
    expect(Object.keys(channelRegistry).sort()).toEqual(
      ["email", "imessage", "signal", "telegram", "whatsapp", "xmtp"].sort(),
    );
  });

  it("the stub adapters are no-ops (canSend=false, send → not-implemented)", async () => {
    const e = notifyEnv();
    const owner = { id: 1, contactRef: "email:x@y.com", alertChannels: "xmtp" };
    for (const name of ["xmtp", "telegram", "imessage", "whatsapp", "signal"]) {
      const ch = getChannel(name)!;
      expect(await ch.canSend(e, owner)).toBe(false);
      expect(await ch.send(e, owner, { subject: "s", text: "t" })).toEqual({ ok: false, reason: "not-implemented" });
    }
  });

  it("defaults enabled channels to ['email'] when unset", () => {
    expect(enabledChannels({ id: 1 })).toEqual(["email"]);
    expect(enabledChannels({ id: 1, alertChannels: "" })).toEqual(["email"]);
    expect(enabledChannels({ id: 1, alertChannels: "email, telegram" })).toEqual(["email", "telegram"]);
  });
});

describe("match alert email copy (Ishtar voice)", () => {
  it("carries the come-look line and the matches URL", () => {
    const url = "https://ishtar.numetal.xyz/matches/?token=abc";
    const m = matchAlertEmail(url);
    expect(m.subject).toMatch(/match/i);
    expect(m.text).toContain("your agent found someone");
    expect(m.text).toContain(url);
    expect(m.html).toContain("See your match");
  });
});

describe("notifyOwner — idempotent email dispatch", () => {
  it("sends ONE email and records a 'sent' notification row", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "e1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const e = notifyEnv();
    const ownerId = await makeOwner("dater@example.com");

    const r = await notifyOwner(env.DB, e, ownerId, "match", { coupleId: 99, matchesUrl: "https://ishtar.numetal.xyz/matches/?token=t" });
    expect(r.sent).toEqual(["email"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The email went to the decrypted contact, with the come-look copy.
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.to).toBe("dater@example.com");
    expect(String(body.text)).toContain("your agent found someone");

    const rows = (await env.DB.prepare("SELECT * FROM notifications WHERE owner_id=?1").bind(ownerId).all()).results as Array<{ status: string; channel: string; ref: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "sent", channel: "email", ref: "99" });
  });

  it("a replay (same owner/kind/ref/channel) sends NO second email", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "e1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const e = notifyEnv();
    const ownerId = await makeOwner("dater@example.com");

    await notifyOwner(env.DB, e, ownerId, "match", { coupleId: 5 });
    const second = await notifyOwner(env.DB, e, ownerId, "match", { coupleId: 5 });
    expect(second.skipped).toEqual(["email"]); // claim lost on replay
    expect(second.sent).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1); // exactly one email ever
    const cnt = (await env.DB.prepare("SELECT COUNT(*) c FROM notifications WHERE owner_id=?1").bind(ownerId).first<{ c: number }>())!.c;
    expect(cnt).toBe(1);
  });
});

describe("notifyMatchForCouple — the trigger (featured-human gate)", () => {
  it("emails the enrolled human in a new couple exactly once (idempotent on replay)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "e1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const e = notifyEnv();

    await addFeaturedOwnerIdColumn(); // enrol branch's column
    const humanOwner = await makeOwner("human@example.com");
    await enrolFeaturedHuman(humanOwner);
    const agentOwner = await makeOwner(null); // the other side of the couple is an agent (no email)
    const pa = await makePersona(humanOwner, "human_h");
    const pb = await makePersona(agentOwner, "agent_h");
    const coupleId = await makeCouple(pa, pb);

    await notifyMatchForCouple(e, coupleId);
    await notifyMatchForCouple(e, coupleId); // replay (re-entered beat) → no second send

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = (await env.DB.prepare("SELECT owner_id, ref, status FROM notifications").all()).results as Array<{ owner_id: number; ref: string; status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ owner_id: humanOwner, ref: String(coupleId), status: "sent" });
  });

  it("two non-featured / agent personas → NO email, NO notification rows", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "e1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const e = notifyEnv();

    await addFeaturedOwnerIdColumn();
    // Two owners, neither enrolled via a featured post (one even has an email — must still NOT fire).
    const o1 = await makeOwner("notenrolled@example.com");
    const o2 = await makeOwner(null);
    const pa = await makePersona(o1, "x1");
    const pb = await makePersona(o2, "x2");
    const coupleId = await makeCouple(pa, pb);

    await notifyMatchForCouple(e, coupleId);
    expect(fetchMock).not.toHaveBeenCalled();
    const cnt = (await env.DB.prepare("SELECT COUNT(*) c FROM notifications").first<{ c: number }>())!.c;
    expect(cnt).toBe(0);
  });

  it("an 'agent' featured post does NOT count as an enrolled human", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "e1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const e = notifyEnv();

    await addFeaturedOwnerIdColumn();
    const ownerId = await makeOwner("agentpost@example.com");
    await env.DB.prepare(
      "INSERT INTO featured_posts (author_kind, public_summary, order_id, status, owner_id) VALUES ('agent','b','ord-agent','live',?1)",
    )
      .bind(ownerId)
      .run();
    const pb = await makePersona(await makeOwner(null), "y2");
    const coupleId = await makeCouple(await makePersona(ownerId, "y1"), pb);

    await notifyMatchForCouple(e, coupleId);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops when featured_posts.owner_id doesn't exist yet (enrol branch not merged)", async () => {
    // NB: this isolate's featured_posts has NO owner_id column (we don't add it here).
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "e1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const e = notifyEnv();
    const ownerId = await makeOwner("human@example.com");
    const coupleId = await makeCouple(await makePersona(ownerId, "z1"), await makePersona(await makeOwner(null), "z2"));
    await notifyMatchForCouple(e, coupleId); // must not throw, must not send
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
