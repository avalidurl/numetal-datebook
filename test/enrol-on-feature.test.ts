import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  reserveHumanSlot,
  handleLlamapayEvent,
  enrolFeaturedHuman,
  claimAndPublishFeatured,
} from "../src/routes/featured";
import type { LlamapayEvent } from "../src/payments/llamapay";
import { db as makeDb } from "../src/db/client";
import type { GuardFn } from "../src/chaperone";
import type { PaymentProvider } from "../src/payments/x402";
import type { Env } from "../src/env";

// Stub the chaperone classifier so we exercise OUR enrol path, not the remote Llama-Guard model.
const okGuard: GuardFn = async () => ({ safe: true, raw: "safe" });

const rnd = () => Math.random().toString(36).slice(2);
const WEBHOOK_SECRET = "whsec_test_enrol";
const lpEnv = (over: Partial<Env> = {}): Env => ({
  ...(env as unknown as Env),
  LLAMAPAY_API_KEY: "llamapay_sk_test_enrol",
  LLAMAPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  ...over,
});

function chargeStub() {
  const fn = async () => ({ ok: true, hostedUrl: `https://checkout.llamapay.io/pay/${rnd()}` });
  return { fn };
}
const reserveInput = (over: Record<string, unknown> = {}) => ({
  authorKind: "human" as const,
  publicSummary: "seeks a co-conspirator who reads footnotes; argues with citations",
  email: `poster_${rnd()}@example.com`,
  over18: true as const,
  ...over,
});
const freshIp = () => `203.0.113.${Math.floor(Math.random() * 254) + 1}`;

const confirmEvent = (orderId: string, paymentId = "pay_" + rnd(), eventId = "evt_" + rnd()): LlamapayEvent => ({
  id: eventId,
  type: "charge:confirmed",
  data: { id: paymentId, metadata: { orderId }, hosted_url: "https://checkout.llamapay.io/pay/x", pricing_type: "fixed_price" },
});

// Reserve a human slot and return its server-generated orderId.
async function reserve(over: Record<string, unknown> = {}): Promise<string> {
  const db = makeDb(env.DB);
  const r = await reserveHumanSlot(db, lpEnv(), reserveInput(over), freshIp(), { guard: okGuard, createCharge: chargeStub().fn });
  if (r.kind !== "reserved") throw new Error(`reserve failed: ${r.kind}`);
  return r.orderId;
}

describe("ENROL-ON-FEATURE — featured humans become matchable personas", () => {
  beforeEach(async () => {
    for (const t of [
      "featured_posts", "featured_orphaned_payments", "settings", "buyback_reserve",
      "chat_accounts", "chaperone_decisions", "llamapay_webhook_events", "events",
      "personas", "owners",
    ])
      await env.DB.prepare(`DELETE FROM ${t}`).run().catch(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("a confirmed HUMAN webhook creates an owner + persona, sets owner_id/persona_id, and admits (matchable)", async () => {
    const db = makeDb(env.DB);
    const inp = reserveInput({ reveal: "call me maybe" });
    const r = await reserveHumanSlot(db, lpEnv(), inp, freshIp(), { guard: okGuard, createCharge: chargeStub().fn });
    if (r.kind !== "reserved") throw new Error("setup");
    const orderId = r.orderId;

    const out = await handleLlamapayEvent(db, lpEnv(), confirmEvent(orderId, "pay_enrol_1"), { sendEmail: async () => {}, guard: okGuard });
    expect(out.kind).toBe("live");

    // The post is linked to an owner + persona.
    const post = await env.DB
      .prepare("SELECT owner_id, persona_id, status FROM featured_posts WHERE order_id=?1")
      .bind(orderId)
      .first<{ owner_id: number | null; persona_id: number | null; status: string }>();
    expect(post?.status).toBe("live");
    expect(post?.owner_id).toBeTruthy();
    expect(post?.persona_id).toBeTruthy();

    // The owner exists, agent_represented, 18+ attested, and its contactRef is the SEALED email (the
    // private contact pointer — reveal stays gated downstream; never served to boards).
    const owner = await env.DB
      .prepare("SELECT tier, age_attested, contact_ref, status FROM owners WHERE id=?1")
      .bind(post!.owner_id)
      .first<{ tier: string; age_attested: number; contact_ref: string; status: string }>();
    expect(owner?.tier).toBe("agent_represented");
    expect(Number(owner?.age_attested)).toBe(1);
    expect(owner?.contact_ref).toBe(inp.email); // dev (no ENCRYPTION_KEY) → sealed email is plaintext-equal

    // The persona is ADMITTED — i.e. matchable: the match coordinator selects WHERE status='admitted'.
    const persona = await env.DB
      .prepare("SELECT status, persona_age, owner_id, heart_json FROM personas WHERE id=?1")
      .bind(post!.persona_id)
      .first<{ status: string; persona_age: string; owner_id: number; heart_json: string }>();
    expect(persona?.status).toBe("admitted"); // ← matchable on the floor, courts automatically
    expect(persona?.persona_age).toBe("18+");
    expect(persona?.owner_id).toBe(post!.owner_id);
    // The heart is built from the public summary + the reveal note (the onboard heartText shape).
    expect(persona?.heart_json).toContain("footnotes");
    expect(persona?.heart_json).toContain("call me maybe");

    // It is selectable by the EXACT predicate the coordinator uses (status='admitted').
    const matchable = await env.DB
      .prepare("SELECT COUNT(*) c FROM personas WHERE status='admitted'")
      .first<{ c: number }>();
    expect(Number(matchable?.c)).toBe(1);
  });

  it("is IDEMPOTENT on replay — a re-driven event does NOT create a second owner or persona", async () => {
    const db = makeDb(env.DB);
    const orderId = await reserve();
    const ev = confirmEvent(orderId, "pay_idem_enrol", "evt_idem_enrol_fixed");

    // First delivery enrols.
    const a = await handleLlamapayEvent(db, lpEnv(), ev, { sendEmail: async () => {}, guard: okGuard });
    expect(a.kind).toBe("live");
    // Exact-same event id → dedup short-circuits to replay (never re-runs enrol).
    const b = await handleLlamapayEvent(db, lpEnv(), ev, { sendEmail: async () => {}, guard: okGuard });
    expect(b.kind).toBe("replay");

    const owners = await env.DB.prepare("SELECT COUNT(*) c FROM owners").first<{ c: number }>();
    const personas = await env.DB.prepare("SELECT COUNT(*) c FROM personas").first<{ c: number }>();
    expect(Number(owners?.c)).toBe(1); // exactly one owner
    expect(Number(personas?.c)).toBe(1); // exactly one persona
  });

  it("the owner_id guard prevents a double-enrol even if enrol is re-invoked directly (pending→confirmed re-drive)", async () => {
    const db = makeDb(env.DB);
    const orderId = await reserve();
    // pending then confirmed (distinct event ids): the confirmed event sees the row already live (the
    // pending flip already enrolled), so it short-circuits before enrol — no second owner.
    const pending: LlamapayEvent = { id: "evt_p_" + rnd(), type: "charge:pending", data: { id: "pay_pc", metadata: { orderId } } };
    const confirmed: LlamapayEvent = { id: "evt_c_" + rnd(), type: "charge:confirmed", data: { id: "pay_pc", metadata: { orderId } } };
    await handleLlamapayEvent(db, lpEnv(), pending, { sendEmail: async () => {}, guard: okGuard });
    await handleLlamapayEvent(db, lpEnv(), confirmed, { sendEmail: async () => {}, guard: okGuard });

    const owners = await env.DB.prepare("SELECT COUNT(*) c FROM owners").first<{ c: number }>();
    expect(Number(owners?.c)).toBe(1);

    // Calling enrol AGAIN directly with the now-linked post is a no-op (owner_id already set).
    const row = await env.DB
      .prepare("SELECT id, order_id, public_summary, reveal_fields, email_sealed, author_ref, owner_id FROM featured_posts WHERE order_id=?1")
      .bind(orderId)
      .first<any>();
    const again = await enrolFeaturedHuman(db, lpEnv(), row, { guard: okGuard });
    expect(again.enrolled).toBe(false);
    expect(again.reason).toBe("already enrolled");
    const ownersAfter = await env.DB.prepare("SELECT COUNT(*) c FROM owners").first<{ c: number }>();
    expect(Number(ownersAfter?.c)).toBe(1); // still one
  });

  it("an AGENT featured post does NOT get a bogus human persona (no fabrication, no human owner)", async () => {
    const db = makeDb(env.DB);
    const payProvider = (payer = "0xAgentPayer"): PaymentProvider => ({
      network: "eip155:84532",
      facilitator: "mock",
      async verify() { return { verified: true, payer, tx: "0xAGENTTX", amountUsdc: "50" }; },
    });
    const out = await claimAndPublishFeatured(
      db,
      lpEnv(),
      { authorKind: "agent", authorRef: "bot_" + rnd(), publicSummary: "agent seeks agent", ref: "agentref_" + rnd() },
      "0xPAY",
      { provider: payProvider(), guard: okGuard },
    );
    expect(out.kind).toBe("live");

    // No persona and no owner were fabricated for the agent post (its authorRef matched no persona).
    const personas = await env.DB.prepare("SELECT COUNT(*) c FROM personas").first<{ c: number }>();
    const owners = await env.DB.prepare("SELECT COUNT(*) c FROM owners").first<{ c: number }>();
    expect(Number(personas?.c)).toBe(0);
    expect(Number(owners?.c)).toBe(0);
    // The post is left unlinked (no owner_id/persona_id invented).
    if (out.kind === "live") {
      const post = await env.DB.prepare("SELECT owner_id, persona_id FROM featured_posts WHERE id=?1").bind(out.id).first<{ owner_id: number | null; persona_id: number | null }>();
      expect(post?.owner_id).toBeNull();
      expect(post?.persona_id).toBeNull();
    }
  });

  it("FINDING 1: an AGENT post whose authorRef equals an existing (victim) handle does NOT stamp that persona's owner_id/persona_id (anti-spoof)", async () => {
    const db = makeDb(env.DB);
    // Seed a VICTIM persona+owner already on the floor (a real dater with a publicly-known handle).
    const victimOwner = await env.DB
      .prepare("INSERT INTO owners (tier, status, age_attested) VALUES ('agent_represented','admitted',1) RETURNING id")
      .first<{ id: number }>();
    const victimHandle = "victim_bot_" + rnd();
    const victimPersona = await env.DB
      .prepare("INSERT INTO personas (owner_id, handle, model, heart_json, persona_age, status) VALUES (?1, ?2, 'm', '{}', '18+', 'admitted') RETURNING id")
      .bind(victimOwner!.id, victimHandle)
      .first<{ id: number }>();

    // An ATTACKER pays for a featured post and supplies the VICTIM's public handle as authorRef. With no
    // proof of ownership, the old code would graft the victim's owner_id onto the attacker's post →
    // tripping the human match-notify gate into an unsolicited "you have a match" email to the victim.
    const payProvider: PaymentProvider = {
      network: "eip155:84532",
      facilitator: "mock",
      async verify() { return { verified: true, payer: "0xAttacker", tx: "0xTXSPOOF", amountUsdc: "50" }; },
    };
    const out = await claimAndPublishFeatured(
      db,
      lpEnv(),
      { authorKind: "agent", authorRef: victimHandle, publicSummary: "i am definitely the victim, pinky promise", ref: "agentref_" + rnd() },
      "0xPAY",
      { provider: payProvider, guard: okGuard },
    );
    expect(out.kind).toBe("live");
    if (out.kind !== "live") return;

    // The attacker's post is NOT linked to the victim — owner_id/persona_id stay NULL (correct: an agent
    // post never carries owner_id; only the trusted server-side human enrol sets it).
    const post = await env.DB.prepare("SELECT owner_id, persona_id FROM featured_posts WHERE id=?1").bind(out.id).first<{ owner_id: number | null; persona_id: number | null }>();
    expect(post?.owner_id).toBeNull();
    expect(post?.persona_id).toBeNull();

    // The victim's own persona/owner are untouched (no extra rows, none re-pointed).
    const personaCount = await env.DB.prepare("SELECT COUNT(*) c FROM personas").first<{ c: number }>();
    expect(Number(personaCount?.c)).toBe(1); // still just the victim's persona
    const stillVictim = await env.DB.prepare("SELECT owner_id FROM personas WHERE id=?1").bind(victimPersona!.id).first<{ owner_id: number }>();
    expect(stillVictim?.owner_id).toBe(victimOwner!.id);
  });

  it("FINDING 2: link UPDATE fails after the owner insert, then a re-claim → EXACTLY ONE owner + ONE persona, owner_id ends set", async () => {
    const db = makeDb(env.DB);
    const orderId = await reserve({ reveal: "footnote enjoyer" });

    // Drive enrol on a row whose env.DB.prepare THROWS for the final link UPDATE (the
    // "UPDATE featured_posts SET owner_id=...persona_id=..." statement) — simulating a crash after the
    // owner insert + admit but before the post is linked. The owner+persona are written; the post's
    // owner_id stays NULL (orphaned owner — exactly the non-atomic bug).
    const realDb = lpEnv().DB;
    let threw = false;
    const failingDb = {
      ...realDb,
      prepare(sql: string) {
        if (sql.includes("UPDATE featured_posts SET owner_id") && sql.includes("persona_id")) {
          threw = true;
          throw new Error("simulated crash during the link UPDATE");
        }
        return realDb.prepare(sql);
      },
    } as typeof realDb;

    const row = await realDb
      .prepare("SELECT id, order_id, public_summary, reveal_fields, email_sealed, author_ref, owner_id FROM featured_posts WHERE order_id=?1")
      .bind(orderId)
      .first<any>();

    await expect(
      enrolFeaturedHuman(db, { ...lpEnv(), DB: failingDb }, row, { guard: okGuard }),
    ).rejects.toThrow(/simulated crash/);
    expect(threw).toBe(true);

    // Post-crash state: the owner + persona were inserted, but the post's owner_id is still NULL
    // (the link UPDATE never landed) — the orphaned-owner condition.
    const afterCrash = await realDb.prepare("SELECT owner_id, persona_id FROM featured_posts WHERE order_id=?1").bind(orderId).first<{ owner_id: number | null; persona_id: number | null }>();
    expect(afterCrash?.owner_id).toBeNull();
    const ownersAfterCrash = await realDb.prepare("SELECT COUNT(*) c FROM owners").first<{ c: number }>();
    expect(Number(ownersAfterCrash?.c)).toBe(1); // the orphaned owner

    // RE-CLAIM (a real env.DB now): the deterministic-handle reuse-lookup finds the existing persona and
    // REUSES its owner — it must NOT insert a second owner, and it must (re)link the post.
    const reRow = await realDb
      .prepare("SELECT id, order_id, public_summary, reveal_fields, email_sealed, author_ref, owner_id FROM featured_posts WHERE order_id=?1")
      .bind(orderId)
      .first<any>();
    const out = await enrolFeaturedHuman(db, lpEnv(), reRow, { guard: okGuard });
    expect(out.enrolled).toBe(true);

    // EXACTLY ONE owner + ONE persona for this order, and the post's owner_id is now set.
    const owners = await realDb.prepare("SELECT COUNT(*) c FROM owners").first<{ c: number }>();
    const personas = await realDb.prepare("SELECT COUNT(*) c FROM personas WHERE handle=?1").bind(`window-${orderId}`.slice(0, 64)).first<{ c: number }>();
    expect(Number(owners?.c)).toBe(1); // NOT duplicated by the re-claim
    expect(Number(personas?.c)).toBe(1);
    const linked = await realDb.prepare("SELECT owner_id, persona_id FROM featured_posts WHERE order_id=?1").bind(orderId).first<{ owner_id: number | null; persona_id: number | null }>();
    expect(linked?.owner_id).toBeTruthy();
    expect(linked?.persona_id).toBeTruthy();
  });
});
