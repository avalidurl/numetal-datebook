import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  reserveHumanSlot,
  handleLlamapayEvent,
  getFeaturedStatus,
  claimAndPublishFeatured,
} from "../src/routes/featured";
import { createLlamapayCharge, verifyLlamapayWebhook, type LlamapayEvent } from "../src/payments/llamapay";
import { renderTR100 } from "../src/payments/tr100";
import { db as makeDb } from "../src/db/client";
import type { GuardFn } from "../src/chaperone";
import type { PaymentProvider } from "../src/payments/x402";
import type { Env } from "../src/env";

const okGuard: GuardFn = async () => ({ safe: true, raw: "safe" });
const s12Guard: GuardFn = async () => ({ safe: false, raw: "unsafe\nS12", category: "S12" });

const rnd = () => Math.random().toString(36).slice(2);
const WEBHOOK_SECRET = "whsec_test_window_llamapay";
// An env with the LlamaPay secrets set (the bundled test env leaves them unset → 503/dark).
const lpEnv = (over: Partial<Env> = {}): Env => ({ ...(env as unknown as Env), LLAMAPAY_API_KEY: "llamapay_sk_test_123", LLAMAPAY_WEBHOOK_SECRET: WEBHOOK_SECRET, ...over });

// A charge stub: records the args, returns a hosted_url.
function chargeStub() {
  const calls: Array<{ orderId: string; redirectUrl: string; cancelUrl: string }> = [];
  const fn = async (orderId: string, redirectUrl: string, cancelUrl: string) => {
    calls.push({ orderId, redirectUrl, cancelUrl });
    return { ok: true, hostedUrl: `https://checkout.llamapay.io/pay/${rnd()}` };
  };
  return { fn, calls };
}

const reserveInput = (over: Record<string, unknown> = {}) => ({
  authorKind: "human" as const,
  publicSummary: "loves arguing with citations; seeks the same",
  email: `poster_${rnd()}@example.com`,
  over18: true as const,
  ref: "ref_" + rnd(),
  ...over,
});

// Build a correctly-signed LlamaPay webhook { rawBody, signature } for an event.
async function signedWebhook(event: LlamapayEvent, secret = WEBHOOK_SECRET): Promise<{ rawBody: string; signature: string }> {
  const rawBody = JSON.stringify({ event });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const signature = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { rawBody, signature };
}

const confirmEvent = (orderId: string, paymentId = "pay_" + rnd(), eventId = "evt_" + rnd()): LlamapayEvent => ({
  id: eventId,
  type: "charge:confirmed",
  data: { id: paymentId, metadata: { orderId }, hosted_url: "https://checkout.llamapay.io/pay/x", pricing_type: "fixed_price" },
});

describe("The Window — LlamaPay human path", () => {
  beforeEach(async () => {
    for (const t of ["featured_posts", "settings", "buyback_reserve", "chat_accounts", "chaperone_decisions", "llamapay_webhook_events", "events"])
      await env.DB.prepare(`DELETE FROM ${t}`).run().catch(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  describe("reserve", () => {
    it("claims a slot, seals the email, returns checkoutUrl + orderId + expiresInMinutes", async () => {
      const db = makeDb(env.DB);
      const charge = chargeStub();
      const inp = reserveInput();
      const r = await reserveHumanSlot(db, lpEnv(), inp, { guard: okGuard, createCharge: charge.fn });
      expect(r.kind).toBe("reserved");
      if (r.kind !== "reserved") return;
      expect(r.orderId).toBe(`featured:human:${inp.ref}`);
      expect(r.checkoutUrl).toMatch(/^https:\/\/checkout\.llamapay\.io\/pay\//);
      expect(r.expiresInMinutes).toBe(10);
      // redirect_url is exactly the /window page with ?order=<orderId>
      expect(charge.calls[0]!.redirectUrl).toBe(`https://ishtar.numetal.xyz/window/?order=${encodeURIComponent(r.orderId)}`);
      // a reserving row exists, email is sealed (not plaintext) when ENCRYPTION_KEY is set; here dev → plaintext sealed
      const row = await env.DB.prepare("SELECT status, email_sealed, charge_hosted_url FROM featured_posts WHERE order_id=?1").bind(r.orderId).first<{ status: string; email_sealed: string; charge_hosted_url: string }>();
      expect(row?.status).toBe("reserving");
      expect(row?.email_sealed).toBe(inp.email); // dev (no ENCRYPTION_KEY) → seal is a no-op
      expect(row?.charge_hosted_url).toBe(r.checkoutUrl);
    });

    it("the LlamaPay charge POST sends Authorization === the raw key and the right body (metadata.orderId + redirect_url)", async () => {
      const captured: { url?: string; headers?: Record<string, string>; body?: any } = {};
      const fakeFetch = (async (url: string, init: RequestInit) => {
        captured.url = url;
        captured.headers = init.headers as Record<string, string>;
        captured.body = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ data: { hosted_url: "https://checkout.llamapay.io/pay/abc" } }), { status: 200 });
      }) as unknown as typeof fetch;
      const e = lpEnv();
      const res = await createLlamapayCharge(e, { orderId: "featured:human:zzz", amount: "50.00", redirectUrl: "https://ishtar.numetal.xyz/window/?order=featured%3Ahuman%3Azzz", cancelUrl: "https://ishtar.numetal.xyz/window/" }, fakeFetch);
      expect(res.ok).toBe(true);
      expect(res.hostedUrl).toBe("https://checkout.llamapay.io/pay/abc");
      expect(captured.url).toBe("https://api.llamapay.io/charges");
      expect(captured.headers!.authorization).toBe("llamapay_sk_test_123"); // VERBATIM — no "Bearer"
      expect(captured.body.pricing_type).toBe("fixed_price");
      expect(captured.body.local_price).toEqual({ amount: "50.00", currency: "USD" });
      expect(captured.body.metadata.orderId).toBe("featured:human:zzz");
      expect(captured.body.redirect_url).toBe("https://ishtar.numetal.xyz/window/?order=featured%3Ahuman%3Azzz");
      expect(captured.body.cancel_url).toBe("https://ishtar.numetal.xyz/window/");
    });

    it("returns 'full' when the board is full (no charge created)", async () => {
      const db = makeDb(env.DB);
      await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('featured_daily_cap','1')").run();
      const charge = chargeStub();
      const a = await reserveHumanSlot(db, lpEnv(), reserveInput(), { guard: okGuard, createCharge: charge.fn });
      expect(a.kind).toBe("reserved");
      // The slot is warm-reserving (NOT yet paid). The second reserve must see it and return full.
      const b = await reserveHumanSlot(db, lpEnv(), reserveInput(), { guard: okGuard, createCharge: charge.fn });
      expect(b.kind).toBe("full");
      expect(charge.calls).toHaveLength(1); // no charge for the rejected poster
    });

    // ─── THE cap-regression test: a warm reserving row MUST be counted (the created_at format bug) ───
    it("REGRESSION: cap=1, two DISTINCT refs, NO payment between → the 2nd returns full (warm reservation counted)", async () => {
      const db = makeDb(env.DB);
      await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('featured_daily_cap','1')").run();
      const charge = chargeStub();
      const first = await reserveHumanSlot(db, lpEnv(), reserveInput({ ref: "first_ref_" + rnd() }), { guard: okGuard, createCharge: charge.fn });
      expect(first.kind).toBe("reserved"); // slot held, unpaid
      // No webhook/payment in between — the first row is still 'reserving'.
      const reservingCount = await env.DB.prepare("SELECT count(*) c FROM featured_posts WHERE status='reserving'").first<{ c: number }>();
      expect(Number(reservingCount?.c)).toBe(1);
      const second = await reserveHumanSlot(db, lpEnv(), reserveInput({ ref: "second_ref_" + rnd() }), { guard: okGuard, createCharge: charge.fn });
      expect(second.kind).toBe("full"); // the warm reservation occupies the only slot → over-cap prevented
      expect(charge.calls).toHaveLength(1); // only the first poster's charge was created
    });

    it("chaperone blocks an S12 post BEFORE any slot/charge", async () => {
      const db = makeDb(env.DB);
      const charge = chargeStub();
      const r = await reserveHumanSlot(db, lpEnv(), reserveInput(), { guard: s12Guard, createCharge: charge.fn });
      expect(r.kind).toBe("blocked");
      expect(charge.calls).toHaveLength(0);
      const cnt = await env.DB.prepare("SELECT count(*) c FROM featured_posts").first<{ c: number }>();
      expect(Number(cnt?.c)).toBe(0); // nothing claimed
    });

    it("re-reserving the same ref returns the held checkout (no second charge)", async () => {
      const db = makeDb(env.DB);
      const charge = chargeStub();
      const inp = reserveInput();
      const r1 = await reserveHumanSlot(db, lpEnv(), inp, { guard: okGuard, createCharge: charge.fn });
      const r2 = await reserveHumanSlot(db, lpEnv(), inp, { guard: okGuard, createCharge: charge.fn });
      expect(r1.kind).toBe("reserved");
      expect(r2.kind).toBe("reserved");
      if (r1.kind === "reserved" && r2.kind === "reserved") expect(r2.checkoutUrl).toBe(r1.checkoutUrl);
      expect(charge.calls).toHaveLength(1);
    });
  });

  describe("webhook", () => {
    it("verifies a valid signature, rejects a bad one (401), 503 when unconfigured", async () => {
      const ev = confirmEvent("featured:human:abc");
      const { rawBody, signature } = await signedWebhook(ev);
      const good = await verifyLlamapayWebhook(lpEnv(), rawBody, signature);
      expect(good.ok).toBe(true);
      expect(good.event?.id).toBe(ev.id);
      const bad = await verifyLlamapayWebhook(lpEnv(), rawBody, "deadbeef" + signature.slice(8));
      expect(bad.ok).toBe(false);
      expect(bad.reason).toBe("bad signature");
      // unconfigured env → fail-closed
      const dark = await verifyLlamapayWebhook({ ...(env as unknown as Env), LLAMAPAY_WEBHOOK_SECRET: undefined }, rawBody, signature);
      expect(dark.ok).toBe(false);
    });

    it("charge:confirmed flips reserving→live and records the LlamaPay payment ref", async () => {
      const db = makeDb(env.DB);
      const inp = reserveInput();
      const reserved = await reserveHumanSlot(db, lpEnv(), inp, { guard: okGuard, createCharge: chargeStub().fn });
      expect(reserved.kind).toBe("reserved");
      const orderId = `featured:human:${inp.ref}`;
      let emailed: { to: string; html: string } | null = null;
      const ev = confirmEvent(orderId, "pay_live_1");
      const out = await handleLlamapayEvent(db, lpEnv(), ev, { sendEmail: async (to, _s, html) => { emailed = { to, html }; } });
      expect(out.kind).toBe("live");
      if (out.kind === "live") expect(out.alreadyLive).toBe(false);
      const row = await env.DB.prepare("SELECT status, payment_ref, paid_at, expires_at FROM featured_posts WHERE order_id=?1").bind(orderId).first<{ status: string; payment_ref: string; paid_at: string; expires_at: string }>();
      expect(row?.status).toBe("live");
      expect(row?.payment_ref).toBe("llamapay:pay_live_1");
      expect(row?.paid_at).toBeTruthy();
      expect(row?.expires_at).toBeTruthy();
      // emailed the receipt (email present)
      expect(emailed).not.toBeNull();
      expect(emailed!.to).toBe(inp.email);
      expect(emailed!.html).toContain("THE WINDOW");
      expect(emailed!.html).toContain("llamapay:pay_live_1");
    });

    it("REPLAY the same event.id is idempotent (no double-feature, dedup short-circuit)", async () => {
      const db = makeDb(env.DB);
      const inp = reserveInput();
      await reserveHumanSlot(db, lpEnv(), inp, { guard: okGuard, createCharge: chargeStub().fn });
      const orderId = `featured:human:${inp.ref}`;
      const ev = confirmEvent(orderId, "pay_idem", "evt_idem_fixed");
      let emails = 0;
      const send = async () => { emails++; };
      const a = await handleLlamapayEvent(db, lpEnv(), ev, { sendEmail: send });
      const b = await handleLlamapayEvent(db, lpEnv(), ev, { sendEmail: send });
      expect(a.kind).toBe("live");
      expect(b.kind).toBe("replay"); // same event.id → dedup no-op
      expect(emails).toBe(1); // only the first event emailed/featured
      const liveCount = await env.DB.prepare("SELECT count(*) c FROM featured_posts WHERE status='live'").first<{ c: number }>();
      expect(Number(liveCount?.c)).toBe(1);
    });

    it("pending then confirmed (different event ids) features exactly once", async () => {
      const db = makeDb(env.DB);
      const inp = reserveInput();
      await reserveHumanSlot(db, lpEnv(), inp, { guard: okGuard, createCharge: chargeStub().fn });
      const orderId = `featured:human:${inp.ref}`;
      const pending: LlamapayEvent = { id: "evt_p", type: "charge:pending", data: { id: "pay_x", metadata: { orderId } } };
      const confirmed: LlamapayEvent = { id: "evt_c", type: "charge:confirmed", data: { id: "pay_x", metadata: { orderId } } };
      let emails = 0;
      const p = await handleLlamapayEvent(db, lpEnv(), pending, { sendEmail: async () => { emails++; } });
      const c = await handleLlamapayEvent(db, lpEnv(), confirmed, { sendEmail: async () => { emails++; } });
      expect(p.kind).toBe("live"); // pending counts as paid (tx on chain)
      if (p.kind === "live") expect(p.alreadyLive).toBe(false);
      expect(c.kind).toBe("live");
      if (c.kind === "live") expect(c.alreadyLive).toBe(true); // already live → no second feature
      expect(emails).toBe(1);
    });

    it("missing metadata.orderId → no_order (no crash)", async () => {
      const db = makeDb(env.DB);
      const ev: LlamapayEvent = { id: "evt_noorder", type: "charge:confirmed", data: { id: "pay_n", metadata: {} } };
      const out = await handleLlamapayEvent(db, lpEnv(), ev);
      expect(out.kind).toBe("no_order");
    });

    it("unknown event type → ignored (200 no-op)", async () => {
      const db = makeDb(env.DB);
      const ev: LlamapayEvent = { id: "evt_unknown", type: "charge:created", data: { id: "pay_u", metadata: { orderId: "featured:human:nope" } } };
      const out = await handleLlamapayEvent(db, lpEnv(), ev);
      expect(out.kind).toBe("ignored");
    });
  });

  describe("status", () => {
    it("reserving → live transition; receipt present once live", async () => {
      const db = makeDb(env.DB);
      const inp = reserveInput();
      await reserveHumanSlot(db, lpEnv(), inp, { guard: okGuard, createCharge: chargeStub().fn });
      const orderId = `featured:human:${inp.ref}`;
      const s1 = await getFeaturedStatus(lpEnv(), orderId);
      expect(s1.status).toBe("reserving");
      expect(s1.receipt).toBeUndefined();
      // confirm payment
      await handleLlamapayEvent(db, lpEnv(), confirmEvent(orderId, "pay_status"), { sendEmail: async () => {} });
      const s2 = await getFeaturedStatus(lpEnv(), orderId);
      expect(s2.status).toBe("live");
      expect(s2.receipt).toBeDefined();
      expect(s2.receiptHtml).toContain("llamapay:pay_status");
    });

    it("unknown order → status unknown", async () => {
      const s = await getFeaturedStatus(lpEnv(), "featured:human:does-not-exist");
      expect(s.status).toBe("unknown");
    });
  });

  describe("TR-100 receipt", () => {
    const base = {
      orderId: "featured:human:demo",
      handle: "nightowl",
      publicSummary: "seeks a co-conspirator who reads footnotes",
      amountUsd: "50.00",
      paidAt: "2026-06-30T12:00:00.000Z",
      windowFrom: "2026-06-30T12:00:00.000Z",
      windowTo: "2026-07-01T12:00:00.000Z",
      slotOf: 3,
      slotCap: 10,
    };

    it("has the TR-100 fields + the U.S. Graphics attribution", () => {
      const html = renderTR100({ ...base, authorKind: "human", llamapayId: "pay_abc", llamapayHostedUrl: "https://checkout.llamapay.io/pay/abc" });
      expect(html).toContain("THE WINDOW");
      expect(html).toContain("REPORT NO.");
      expect(html).toContain("TR-W-");
      expect(html).toContain("PAYMENT REF");
      expect(html).toContain("$50.00 USD");
      expect(html).toContain("3 of 10 today");
      expect(html).toContain("nightowl");
      expect(html).toContain("U.S. Graphics Co.");
      expect(html).toContain("BSD-3-Clause");
    });

    it("HUMAN path shows the llamapay payment ref and NO basescan link", () => {
      const html = renderTR100({ ...base, authorKind: "human", llamapayId: "pay_human_1", llamapayHostedUrl: "https://checkout.llamapay.io/pay/h1" });
      expect(html).toContain("llamapay:pay_human_1");
      expect(html).not.toContain("basescan.org");
      expect(html).toContain("LlamaPay"); // processor line
    });

    it("AGENT path shows the basescan settle-tx link", () => {
      const html = renderTR100({ ...base, authorKind: "agent", settlementTx: "0xdeadbeef" });
      expect(html).toContain("https://basescan.org/tx/0xdeadbeef");
      expect(html).toContain("Base · USDC"); // processor/network line
      expect(html).not.toContain("llamapay:");
    });
  });

  describe("agent x402 receipt parity (unchanged path records x402:<tx>)", () => {
    const payProvider = (payer = "0xPayer"): PaymentProvider => ({
      network: "eip155:84532",
      facilitator: "mock",
      async verify() { return { verified: true, payer, tx: "0xAGENTTX", amountUsdc: "50" }; },
    });
    it("an agent post records payment_ref x402:<tx> → its receipt links basescan", async () => {
      const db = makeDb(env.DB);
      const out = await claimAndPublishFeatured(db, env, { authorKind: "agent", authorRef: "bot7", publicSummary: "agent seeks agent", ref: "agentref_" + rnd() }, "0xPAY", { provider: payProvider(), guard: okGuard });
      expect(out.kind).toBe("live");
      if (out.kind !== "live") return;
      const row = await env.DB.prepare("SELECT payment_ref, order_id FROM featured_posts WHERE id=?1").bind(out.id).first<{ payment_ref: string; order_id: string }>();
      expect(row?.payment_ref).toBe("x402:0xAGENTTX");
      const s = await getFeaturedStatus(env as unknown as Env, row!.order_id);
      expect(s.status).toBe("live");
      expect(s.receiptHtml).toContain("https://basescan.org/tx/0xAGENTTX");
    });
  });
});
