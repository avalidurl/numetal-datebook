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

// The client no longer sends `ref`; the server generates the order id. A unique IP per poster (unless a
// test deliberately reuses one to exercise the anti-squatting control).
const reserveInput = (over: Record<string, unknown> = {}) => ({
  authorKind: "human" as const,
  publicSummary: "loves arguing with citations; seeks the same",
  email: `poster_${rnd()}@example.com`,
  over18: true as const,
  ...over,
});
const freshIp = () => `203.0.113.${Math.floor(Math.random() * 254) + 1}`;

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
    for (const t of ["featured_posts", "featured_orphaned_payments", "settings", "buyback_reserve", "chat_accounts", "chaperone_decisions", "llamapay_webhook_events", "events"])
      await env.DB.prepare(`DELETE FROM ${t}`).run().catch(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  describe("reserve", () => {
    it("claims a slot, seals the email, returns a SERVER-GENERATED uuid orderId + checkoutUrl + expiresInMinutes", async () => {
      const db = makeDb(env.DB);
      const charge = chargeStub();
      const inp = reserveInput();
      const r = await reserveHumanSlot(db, lpEnv(), inp, freshIp(), { guard: okGuard, createCharge: charge.fn });
      expect(r.kind).toBe("reserved");
      if (r.kind !== "reserved") return;
      // finding #2: the order id is server-side + high-entropy (uuid), NOT a client value.
      expect(r.orderId).toMatch(/^featured:human:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(r.checkoutUrl).toMatch(/^https:\/\/checkout\.llamapay\.io\/pay\//);
      expect(r.expiresInMinutes).toBe(10);
      // redirect_url is exactly the /window page with ?order=<the server orderId>
      expect(charge.calls[0]!.orderId).toBe(r.orderId);
      expect(charge.calls[0]!.redirectUrl).toBe(`https://ishtar.numetal.xyz/window/?order=${encodeURIComponent(r.orderId)}`);
      const row = await env.DB.prepare("SELECT status, email_sealed, charge_hosted_url FROM featured_posts WHERE order_id=?1").bind(r.orderId).first<{ status: string; email_sealed: string; charge_hosted_url: string }>();
      expect(row?.status).toBe("reserving");
      expect(row?.email_sealed).toBe(inp.email); // dev (no ENCRYPTION_KEY) → seal is a no-op
      expect(row?.charge_hosted_url).toBe(r.checkoutUrl);
    });

    // finding #1 — reveal is a STRING, not a record. A plain-string reveal must SUCCEED (was a 400).
    it("FINDING #1: a string reveal ('call me maybe') reserves successfully and is screened verbatim", async () => {
      const db = makeDb(env.DB);
      const charge = chargeStub();
      let screened = "";
      const captureGuard: GuardFn = async (_db, _env, text) => { screened = text; return { safe: true, raw: "safe" }; };
      const r = await reserveHumanSlot(db, lpEnv(), reserveInput({ reveal: "call me maybe" }), freshIp(), { guard: captureGuard, createCharge: charge.fn });
      expect(r.kind).toBe("reserved");
      // the reveal string is appended to the screen text verbatim (NOT Object.values(...).map(String))
      expect(screened).toContain("call me maybe");
      if (r.kind === "reserved") {
        const row = await env.DB.prepare("SELECT reveal_fields FROM featured_posts WHERE order_id=?1").bind(r.orderId).first<{ reveal_fields: string }>();
        expect(row?.reveal_fields).toBe("call me maybe"); // persisted as the raw string
      }
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
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('featured_daily_cap','1')").run();
      // Deterministic: seed the single slot with a WARM (just-created) 'reserving' occupant directly, instead
      // of depending on a first reserve's charge/warmth timing (the source of a rare cross-run flake). Still
      // exercises the real invariant — a warm reservation counts toward the cap — via the slot-count query.
      await env.DB
        .prepare("INSERT INTO featured_posts (author_kind, public_summary, order_id, status, created_at) VALUES ('human','held','featured:human:occupant','reserving',?1)")
        .bind(new Date().toISOString())
        .run();
      const charge = chargeStub();
      const b = await reserveHumanSlot(db, lpEnv(), reserveInput(), freshIp(), { guard: okGuard, createCharge: charge.fn });
      expect(b.kind).toBe("full");
      expect(charge.calls).toHaveLength(0); // a full board NEVER charges the rejected poster
    });

    // FINDING #5: a FULL board must reject WITHOUT calling the chaperone (claim precedes chaperone).
    it("FINDING #5: a full board returns 409 WITHOUT invoking the chaperone guard", async () => {
      const db = makeDb(env.DB);
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('featured_daily_cap','1')").run();
      const charge = chargeStub();
      // Fill the only slot.
      const a = await reserveHumanSlot(db, lpEnv(), reserveInput(), freshIp(), { guard: okGuard, createCharge: charge.fn });
      expect(a.kind).toBe("reserved");
      // The next poster's chaperone guard must NEVER run (the slot claim fails first → no AI spend / DoS).
      let guardCalls = 0;
      const trapGuard: GuardFn = async () => { guardCalls++; return { safe: true, raw: "safe" }; };
      const b = await reserveHumanSlot(db, lpEnv(), reserveInput(), freshIp(), { guard: trapGuard, createCharge: charge.fn });
      expect(b.kind).toBe("full");
      expect(guardCalls).toBe(0); // chaperone was NOT invoked on a full board
      expect(charge.calls).toHaveLength(1);
    });

    // FINDING #5 (cont.): a chaperone block AFTER the claim must RELEASE the slot.
    it("FINDING #5: a chaperone block releases the just-claimed slot (cap freed)", async () => {
      const db = makeDb(env.DB);
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('featured_daily_cap','1')").run();
      const charge = chargeStub();
      const blocked = await reserveHumanSlot(db, lpEnv(), reserveInput(), freshIp(), { guard: s12Guard, createCharge: charge.fn });
      expect(blocked.kind).toBe("blocked");
      expect(charge.calls).toHaveLength(0); // never reached checkout
      // the blocked row must NOT hold the slot — a fresh okGuard post can still claim the only slot.
      const reservingCount = await env.DB.prepare("SELECT count(*) c FROM featured_posts WHERE status='reserving'").first<{ c: number }>();
      expect(Number(reservingCount?.c)).toBe(0);
      const ok = await reserveHumanSlot(db, lpEnv(), reserveInput(), freshIp(), { guard: okGuard, createCharge: charge.fn });
      expect(ok.kind).toBe("reserved");
    });

    // FINDING #6: anti-squatting — one IP cannot hold two concurrent unpaid reservations.
    it("FINDING #6: same IP, two unpaid reserves → 2nd rejected (squatting); after the 1st expires a new one succeeds", async () => {
      const db = makeDb(env.DB);
      const charge = chargeStub();
      const ip = freshIp();
      const a = await reserveHumanSlot(db, lpEnv(), reserveInput(), ip, { guard: okGuard, createCharge: charge.fn });
      expect(a.kind).toBe("reserved");
      const b = await reserveHumanSlot(db, lpEnv(), reserveInput(), ip, { guard: okGuard, createCharge: charge.fn });
      expect(b.kind).toBe("squatting"); // a second concurrent unpaid reservation from the same IP is rejected
      expect(charge.calls).toHaveLength(1);
      // Age the first reservation past RESERVE_TTL (10 min) → a new reserve from the same IP succeeds.
      await env.DB.prepare("UPDATE featured_posts SET created_at=?1 WHERE status='reserving'").bind(new Date(Date.now() - 11 * 60 * 1000).toISOString()).run();
      const c = await reserveHumanSlot(db, lpEnv(), reserveInput(), ip, { guard: okGuard, createCharge: charge.fn });
      expect(c.kind).toBe("reserved");
      expect(charge.calls).toHaveLength(2);
    });

    // ─── THE cap-regression test: a warm reserving row MUST be counted (the created_at format bug) ───
    it("REGRESSION: cap=1, two DISTINCT posters, NO payment between → the 2nd returns full (warm reservation counted)", async () => {
      const db = makeDb(env.DB);
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('featured_daily_cap','1')").run();
      const charge = chargeStub();
      const first = await reserveHumanSlot(db, lpEnv(), reserveInput(), freshIp(), { guard: okGuard, createCharge: charge.fn });
      expect(first.kind).toBe("reserved"); // slot held, unpaid
      const reservingCount = await env.DB.prepare("SELECT count(*) c FROM featured_posts WHERE status='reserving'").first<{ c: number }>();
      expect(Number(reservingCount?.c)).toBe(1);
      const second = await reserveHumanSlot(db, lpEnv(), reserveInput(), freshIp(), { guard: okGuard, createCharge: charge.fn });
      expect(second.kind).toBe("full"); // the warm reservation occupies the only slot → over-cap prevented
      expect(charge.calls).toHaveLength(1);
    });

    it("chaperone blocks an S12 post (slot released, no charge)", async () => {
      const db = makeDb(env.DB);
      const charge = chargeStub();
      const r = await reserveHumanSlot(db, lpEnv(), reserveInput(), freshIp(), { guard: s12Guard, createCharge: charge.fn });
      expect(r.kind).toBe("blocked");
      expect(charge.calls).toHaveLength(0);
      const live = await env.DB.prepare("SELECT count(*) c FROM featured_posts WHERE status IN ('live','reserving')").first<{ c: number }>();
      expect(Number(live?.c)).toBe(0); // nothing holds a slot
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
      const dark = await verifyLlamapayWebhook({ ...(env as unknown as Env), LLAMAPAY_WEBHOOK_SECRET: undefined }, rawBody, signature);
      expect(dark.ok).toBe(false);
    });

    it("charge:confirmed flips reserving→live and records the LlamaPay payment ref", async () => {
      const db = makeDb(env.DB);
      const inp = reserveInput();
      const reserved = await reserveHumanSlot(db, lpEnv(), inp, freshIp(), { guard: okGuard, createCharge: chargeStub().fn });
      expect(reserved.kind).toBe("reserved");
      if (reserved.kind !== "reserved") return;
      const orderId = reserved.orderId;
      let emailed: { to: string; html: string } | null = null;
      const ev = confirmEvent(orderId, "pay_live_1");
      const out = await handleLlamapayEvent(db, lpEnv(), ev, { sendEmail: async (to, _s, html) => { emailed = { to, html }; } });
      expect(out.kind).toBe("live");
      if (out.kind === "live") expect(out.alreadyLive).toBe(false);
      const row = await env.DB.prepare("SELECT status, payment_ref, paid_at, expires_at, emailed FROM featured_posts WHERE order_id=?1").bind(orderId).first<{ status: string; payment_ref: string; paid_at: string; expires_at: string; emailed: number }>();
      expect(row?.status).toBe("live");
      expect(row?.payment_ref).toBe("llamapay:pay_live_1");
      expect(row?.paid_at).toBeTruthy();
      expect(row?.expires_at).toBeTruthy();
      expect(Number(row?.emailed)).toBe(1); // finding #7: the send outcome is persisted
      expect(emailed).not.toBeNull();
      expect(emailed!.to).toBe(inp.email);
      expect(emailed!.html).toContain("THE WINDOW");
    });

    it("REPLAY the same event.id is idempotent (no double-feature, dedup short-circuit)", async () => {
      const db = makeDb(env.DB);
      const inp = reserveInput();
      const reserved = await reserveHumanSlot(db, lpEnv(), inp, freshIp(), { guard: okGuard, createCharge: chargeStub().fn });
      if (reserved.kind !== "reserved") throw new Error("setup");
      const orderId = reserved.orderId;
      const ev = confirmEvent(orderId, "pay_idem", "evt_idem_fixed");
      let emails = 0;
      const send = async () => { emails++; };
      const a = await handleLlamapayEvent(db, lpEnv(), ev, { sendEmail: send });
      const b = await handleLlamapayEvent(db, lpEnv(), ev, { sendEmail: send });
      expect(a.kind).toBe("live");
      expect(b.kind).toBe("replay"); // same event.id → dedup no-op
      expect(emails).toBe(1);
      const liveCount = await env.DB.prepare("SELECT count(*) c FROM featured_posts WHERE status='live'").first<{ c: number }>();
      expect(Number(liveCount?.c)).toBe(1);
    });

    it("pending then confirmed (different event ids) features exactly once", async () => {
      const db = makeDb(env.DB);
      const inp = reserveInput();
      const reserved = await reserveHumanSlot(db, lpEnv(), inp, freshIp(), { guard: okGuard, createCharge: chargeStub().fn });
      if (reserved.kind !== "reserved") throw new Error("setup");
      const orderId = reserved.orderId;
      const pending: LlamapayEvent = { id: "evt_p", type: "charge:pending", data: { id: "pay_x", metadata: { orderId } } };
      const confirmed: LlamapayEvent = { id: "evt_c", type: "charge:confirmed", data: { id: "pay_x", metadata: { orderId } } };
      let emails = 0;
      const p = await handleLlamapayEvent(db, lpEnv(), pending, { sendEmail: async () => { emails++; } });
      const c = await handleLlamapayEvent(db, lpEnv(), confirmed, { sendEmail: async () => { emails++; } });
      expect(p.kind).toBe("live");
      if (p.kind === "live") expect(p.alreadyLive).toBe(false);
      expect(c.kind).toBe("live");
      if (c.kind === "live") expect(c.alreadyLive).toBe(true);
      expect(emails).toBe(1);
    });

    // FINDING #4: a throw AFTER the point the OLD code marked the event seen, but BEFORE the flip, must
    // NOT permanently drop the paid event. On retry the event still features. A genuine replay is a no-op.
    it("FINDING #4: a throw mid-handler does NOT mark the event seen → the retry still features", async () => {
      const db = makeDb(env.DB);
      const inp = reserveInput();
      const reserved = await reserveHumanSlot(db, lpEnv(), inp, freshIp(), { guard: okGuard, createCharge: chargeStub().fn });
      if (reserved.kind !== "reserved") throw new Error("setup");
      const orderId = reserved.orderId;
      const ev = confirmEvent(orderId, "pay_throw", "evt_throw_fixed");
      // First attempt: the email step throws AFTER the (old) dedup-write point. The handler must not have
      // permanently marked the event seen — i.e. either it features anyway (dedup written only on success)
      // or it leaves the event un-deduped so a retry re-drives it.
      let attempt = 0;
      const flakySend = async () => { attempt++; if (attempt === 1) throw new Error("transient email failure"); };
      await handleLlamapayEvent(db, lpEnv(), ev, { sendEmail: flakySend }).catch(() => {});
      // Retry the SAME event id. It must still result in a live, featured slot (no permanent drop).
      const retry = await handleLlamapayEvent(db, lpEnv(), ev, { sendEmail: flakySend });
      const row = await env.DB.prepare("SELECT status FROM featured_posts WHERE order_id=?1").bind(orderId).first<{ status: string }>();
      expect(row?.status).toBe("live"); // the slot is featured despite the first attempt's throw
      // and a genuine replay AFTER a fully-processed run is idempotent.
      const replay = await handleLlamapayEvent(db, lpEnv(), ev, { sendEmail: flakySend });
      expect(replay.kind).toBe("replay");
      const liveCount = await env.DB.prepare("SELECT count(*) c FROM featured_posts WHERE status='live'").first<{ c: number }>();
      expect(Number(liveCount?.c)).toBe(1); // never double-featured
      // retry resolved to live (or replay) — never a dropped paid event
      expect(["live", "replay"]).toContain(retry.kind);
    });

    // FINDING #3: a confirmed payment for an EXPIRED order — FULL board → orphaned record + alert; with
    // ROOM → re-features.
    it("FINDING #3: confirmed webhook for an EXPIRED order, board FULL → featured_orphaned_payments + status orphaned + alert", async () => {
      const db = makeDb(env.DB);
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('featured_daily_cap','1')").run();
      // The payer reserved, then their reservation expired (e.g. they paid late).
      const inp = reserveInput();
      const reserved = await reserveHumanSlot(db, lpEnv(), inp, freshIp(), { guard: okGuard, createCharge: chargeStub().fn });
      if (reserved.kind !== "reserved") throw new Error("setup");
      const orderId = reserved.orderId;
      await env.DB.prepare("UPDATE featured_posts SET status='expired' WHERE order_id=?1").bind(orderId).run();
      // Meanwhile the board filled with a different live row (cap=1, now occupied).
      const future = new Date(Date.now() + 3_600_000).toISOString();
      await env.DB.prepare("INSERT INTO featured_posts (author_kind, public_summary, order_id, status, expires_at) VALUES ('human','occupant','o_full','live',?1)").bind(future).run();
      // Mock the alert webhook.
      const alertFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
      const out = await handleLlamapayEvent(db, lpEnv({ ALERT_WEBHOOK_URL: "https://alerts.example/hook" }), confirmEvent(orderId, "pay_orphan"));
      expect(out.kind).toBe("orphaned");
      // a paid-but-unfeatured row was persisted
      const orphan = await env.DB.prepare("SELECT order_id, llamapay_payment_id, amount FROM featured_orphaned_payments WHERE order_id=?1").bind(orderId).first<{ order_id: string; llamapay_payment_id: string; amount: string }>();
      expect(orphan?.llamapay_payment_id).toBe("pay_orphan");
      expect(orphan?.amount).toBe("50.00");
      // the order row is now 'orphaned'
      const row = await env.DB.prepare("SELECT status FROM featured_posts WHERE order_id=?1").bind(orderId).first<{ status: string }>();
      expect(row?.status).toBe("orphaned");
      // GET /status surfaces paidButUnfeatured
      const s = await getFeaturedStatus(lpEnv(), orderId);
      expect(s.status).toBe("orphaned");
      expect(s.paidButUnfeatured).toBe(true);
      // the alert fired
      expect(alertFetch).toHaveBeenCalled();
      const alertBody = JSON.parse((alertFetch.mock.calls[0]![1] as RequestInit).body as string);
      expect(alertBody.text).toContain("PAID BUT UNFEATURED");
      // never silently dropped — a record exists
      expect(orphan).not.toBeNull();
    });

    it("FINDING #3: confirmed webhook for an EXPIRED order, board has ROOM → re-features (expired→live)", async () => {
      const db = makeDb(env.DB);
      await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('featured_daily_cap','5')").run();
      const inp = reserveInput();
      const reserved = await reserveHumanSlot(db, lpEnv(), inp, freshIp(), { guard: okGuard, createCharge: chargeStub().fn });
      if (reserved.kind !== "reserved") throw new Error("setup");
      const orderId = reserved.orderId;
      await env.DB.prepare("UPDATE featured_posts SET status='expired' WHERE order_id=?1").bind(orderId).run();
      const out = await handleLlamapayEvent(db, lpEnv(), confirmEvent(orderId, "pay_reclaim"), { sendEmail: async () => {} });
      expect(out.kind).toBe("live");
      const row = await env.DB.prepare("SELECT status, payment_ref FROM featured_posts WHERE order_id=?1").bind(orderId).first<{ status: string; payment_ref: string }>();
      expect(row?.status).toBe("live"); // re-claimed
      expect(row?.payment_ref).toBe("llamapay:pay_reclaim");
      const orphan = await env.DB.prepare("SELECT count(*) c FROM featured_orphaned_payments").first<{ c: number }>();
      expect(Number(orphan?.c)).toBe(0); // not orphaned — there was room
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
    it("reserving → live transition; receipt present once live, emailSent reflected", async () => {
      const db = makeDb(env.DB);
      const inp = reserveInput();
      const reserved = await reserveHumanSlot(db, lpEnv(), inp, freshIp(), { guard: okGuard, createCharge: chargeStub().fn });
      if (reserved.kind !== "reserved") throw new Error("setup");
      const orderId = reserved.orderId;
      const s1 = await getFeaturedStatus(lpEnv(), orderId);
      expect(s1.status).toBe("reserving");
      expect(s1.receipt).toBeUndefined();
      expect(s1.emailSent).toBe(false); // finding #7
      await handleLlamapayEvent(db, lpEnv(), confirmEvent(orderId, "pay_status"), { sendEmail: async () => {} });
      const s2 = await getFeaturedStatus(lpEnv(), orderId);
      expect(s2.status).toBe("live");
      expect(s2.receipt).toBeDefined();
      expect(s2.emailSent).toBe(true); // finding #7
    });

    // FINDING #2: the status receipt JSON must NOT leak the internal payment id ("llamapay:<id>").
    it("FINDING #2: GET /status receipt does NOT expose 'llamapay:' (uses the hosted payment URL)", async () => {
      const db = makeDb(env.DB);
      const inp = reserveInput();
      const charge = chargeStub();
      const reserved = await reserveHumanSlot(db, lpEnv(), inp, freshIp(), { guard: okGuard, createCharge: charge.fn });
      if (reserved.kind !== "reserved") throw new Error("setup");
      const orderId = reserved.orderId;
      await handleLlamapayEvent(db, lpEnv(), confirmEvent(orderId, "pay_secret_id"), { sendEmail: async () => {} });
      const s = await getFeaturedStatus(lpEnv(), orderId);
      expect(s.status).toBe("live");
      const serialized = JSON.stringify(s);
      expect(serialized).not.toContain("llamapay:"); // the raw internal id never surfaces
      expect(serialized).not.toContain("pay_secret_id");
      // the public-safe hosted payment URL is what the receipt links instead
      expect(s.receiptHtml).toContain(reserved.checkoutUrl);
    });

    it("unknown order → status unknown", async () => {
      const s = await getFeaturedStatus(lpEnv(), "featured:human:does-not-exist");
      expect(s.status).toBe("unknown");
    });
  });

  /** Drop `<...>` so box-width math sees glyphs, not markup. Scanner, not a sanitizer. */
  function stripAngleTags(s: string): string {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      if (s.charAt(i) !== "<") {
        out += s.charAt(i);
        continue;
      }
      const close = s.indexOf(">", i + 1);
      if (close < 0) {
        out += s.slice(i);
        break;
      }
      i = close;
    }
    return out;
  }

  /** One-pass entity decode. A chained replace would turn `&amp;lt;` into `<`. */
  function decodeHtmlEntitiesOnce(s: string): string {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      if (s.charAt(i) !== "&") {
        out += s.charAt(i);
        continue;
      }
      const semi = s.indexOf(";", i + 1);
      if (semi < 0 || semi - i > 8) {
        out += "&";
        continue;
      }
      const name = s.slice(i + 1, semi);
      const decoded = name === "amp" ? "&" : name === "lt" ? "<" : name === "gt" ? ">" : name === "quot" ? '"' : "";
      if (!decoded) {
        out += "&";
        continue;
      }
      out += decoded;
      i = semi;
    }
    return out;
  }

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
      const html = renderTR100({ ...base, authorKind: "human", llamapayHostedUrl: "https://checkout.llamapay.io/pay/abc" });
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

    // The attribution must appear EXACTLY ONCE — as the footnote BELOW the box, never duplicated as an
    // in-box (truncated) row. U.S. Graphics stays credited.
    it("credits U.S. Graphics EXACTLY ONCE — as the footnote below the box (not duplicated in-box)", () => {
      const html = renderTR100({ ...base, authorKind: "human", llamapayHostedUrl: "https://checkout.llamapay.io/pay/abc" });
      const ATTRIBUTION = "Receipt layout after the TR-100 Machine Report · U.S. Graphics Co. · BSD-3-Clause © 2024";
      // the full attribution string appears once in the rendered HTML
      const occurrences = html.split(ATTRIBUTION).length - 1;
      expect(occurrences).toBe(1);
      // and that one occurrence is the footnote BELOW the box (after the </pre> that holds the ascii box)
      const afterPre = html.slice(html.indexOf("</pre>"));
      expect(afterPre).toContain(ATTRIBUTION);
      // the box itself (inside <pre>) no longer carries the attribution row
      const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1] ?? "";
      expect(pre).not.toContain("U.S. Graphic"); // neither the full nor the truncated "…U.S. Graphic…"
      // U.S. Graphics is still credited somewhere in the receipt
      expect(html).toContain("U.S. Graphics Co.");
    });

    // After removing the in-box attribution row, the box must still render with aligned borders.
    it("box borders stay aligned after the in-box attribution row is removed", () => {
      const html = renderTR100({ ...base, authorKind: "human", llamapayHostedUrl: "https://checkout.llamapay.io/pay/abc" });
      const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1] ?? "";
      const lines = stripAngleTags(pre).split("\n").filter((l) => l.startsWith("│") || l.startsWith("┌") || l.startsWith("├") || l.startsWith("└"));
      const widths = new Set(lines.map((l) => [...l].length));
      expect(widths.size).toBe(1); // every box line (borders + body) is the same visible width
      // the box closes with a bottom rule directly after the last body row (no trailing footer rule)
      expect(pre.trimEnd().endsWith("┘")).toBe(true);
    });

    it("HUMAN path shows the hosted payment URL (NOT the internal id) and NO basescan link", () => {
      const html = renderTR100({ ...base, authorKind: "human", llamapayHostedUrl: "https://checkout.llamapay.io/pay/h1" });
      expect(html).toContain("https://checkout.llamapay.io/pay/h1");
      expect(html).not.toContain("basescan.org");
      expect(html).toContain("LlamaPay"); // processor line
    });

    it("AGENT path shows the basescan settle-tx link", () => {
      const html = renderTR100({ ...base, authorKind: "agent", settlementTx: "0xdeadbeef" });
      expect(html).toContain("https://basescan.org/tx/0xdeadbeef");
      expect(html).toContain("Base · USDC"); // processor/network line
      expect(html).not.toContain("llamapay:");
    });

    // FINDING #8: a long link ref must render with an aligned right border (link cell truncated + padded),
    // and the FULL ref reprinted in plaintext below the box.
    it("FINDING #8: a 66-char tx ref renders with an aligned right border + the full ref below the box", () => {
      const longTx = "0x" + "a".repeat(64); // 66 chars — overflows the value cell
      const html = renderTR100({ ...base, authorKind: "agent", settlementTx: longTx });
      // every body line inside the box has the same visible width (right border aligned)
      const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1] ?? "";
      const lines = stripAngleTags(pre).split("\n").filter((l) => l.startsWith("│"));
      const widths = new Set(lines.map((l) => [...l].length));
      expect(widths.size).toBe(1); // all body/border lines identical visible width
      // the truncated cell carries an ellipsis, and the FULL href is preserved in the <a>
      expect(html).toContain(`https://basescan.org/tx/${longTx}`);
      // the full ref is reprinted as plaintext below the box
      const afterPre = html.slice(html.indexOf("</pre>"));
      expect(afterPre).toContain(longTx);
    });

    // FINDING #9: a value with &, <, > must be escaped EXACTLY once (no &amp;amp;) and stay aligned.
    it("FINDING #9: a publicSummary with & < > escapes once (no double-escape) and stays aligned", () => {
      const summary = "loves A & B < C > D".repeat(6); // long enough to truncate; carries &, <, >
      const html = renderTR100({ ...base, authorKind: "human", publicSummary: summary, llamapayHostedUrl: "https://checkout.llamapay.io/pay/x" });
      const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1] ?? "";
      expect(pre).toContain("&amp;"); // single-escaped
      expect(pre).not.toContain("&amp;amp;"); // never double-escaped
      expect(pre).not.toContain("&amp;lt;");
      const lines = pre.split("\n").filter((l) => l.startsWith("│"));
      // visible width is identical across body lines: strip <a> markup, then entities count as 1 rendered char.
      const visibleWidth = (l: string) => [...decodeHtmlEntitiesOnce(stripAngleTags(l))].length;
      const widths = new Set(lines.map(visibleWidth));
      expect(widths.size).toBe(1);
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
      const out = await claimAndPublishFeatured(db, env, { authorKind: "agent", authorRef: "bot7", publicSummary: "agent seeks agent", ref: "agentref_" + rnd() }, { paymentHeader: "0xPAY", mppCred: null, isMpp: false, hasPayment: true }, { provider: payProvider(), guard: okGuard });
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
