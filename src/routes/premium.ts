/**
 * x402 paid SKU — the compatibility report. Free until paid: no X-PAYMENT header →
 * 402 challenge. With payment → settle-then-persist (durable, idempotent, fail-closed),
 * THEN generate the artifact. Never deliver without a verified, persisted receipt.
 */
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db as makeDb } from "../db/client";
import { events, premiumOrders } from "../db/schema";
import type { Env } from "../env";
import { utcDay } from "../env";
import { chaperone } from "../chaperone";
import { open } from "../crypto/box";
import { runGuarded } from "../economics/gateway";
import { textOf } from "../economics/pricing";
import { settleAndPersist } from "../payments/receipts";
import { makeX402Provider, SKUS, x402Challenge } from "../payments/x402";

export const premiumRoutes = new Hono<{ Bindings: Env }>();

const bodySchema = z.object({
  ownerId: z.number().int().positive(),
  coupleId: z.number().int().positive().optional(),
});

premiumRoutes.post("/premium/compatibility-report", async (c) => {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "ownerId required" }, 400);
  const { ownerId, coupleId } = parsed.data;
  if (!c.env.PAY_TO) return c.json({ error: "payments not configured" }, 503);

  // Mainnet (real USDC via CDP) is gated: the official CDP facilitator pkg pulls a
  // <7-day @x402/core (freshness quarantine) and settlement needs founder CDP keys +
  // a real $1 acceptance tx. Fail loud until wired (see DEPLOY.md "mainnet x402").
  if (c.env.X402_MODE === "mainnet") {
    return c.json({ error: "mainnet x402 not yet wired — see DEPLOY.md (CDP keys + @x402/core freshness)" }, 503);
  }

  const db = makeDb(c.env.DB);
  const sku = SKUS.compatibility_report!;
  const provider = makeX402Provider(c.env);
  const orderId = `cr:${ownerId}:${coupleId ?? 0}:${utcDay()}`;

  await db
    .insert(premiumOrders)
    .values({
      orderId,
      ownerId,
      coupleId,
      sku: sku.id,
      route: sku.route,
      priceUsd: sku.priceUsd,
      network: provider.network,
      facilitator: provider.facilitator,
      status: "created",
    })
    .onConflictDoNothing()
    .run();

  // Comped participants (e.g. Ishtar + the Intern for the live dating demo) skip the x402 paywall:
  // the real flow runs end-to-end, just without a charge. Everyone else still pays.
  // The comp list is the env X402_FREE_OWNERS PLUS a runtime-settable `x402_free_owners` setting
  // (so the founder can comp a specific owner via /admin/actions/settings without a redeploy).
  const setFree = String(
    (await c.env.DB.prepare("SELECT value FROM settings WHERE key='x402_free_owners'").first<{ value: string }>())?.value ?? "",
  );
  const comped = `${c.env.X402_FREE_OWNERS || ""},${setFree}`
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(String(ownerId));
  let receiptId: number | null = null;
  if (comped) {
    await db.update(premiumOrders).set({ status: "comped" }).where(eq(premiumOrders.orderId, orderId)).run();
  } else {
    const paymentHeader = c.req.header("x-payment");
    if (!paymentHeader) {
      await db.update(premiumOrders).set({ status: "challenged" }).where(eq(premiumOrders.orderId, orderId)).run();
      return x402Challenge({ sku, network: provider.network, payTo: c.env.PAY_TO, orderId });
    }
    const settled = await settleAndPersist(db, c.env, provider, { orderId, sku, payTo: c.env.PAY_TO }, paymentHeader);
    if (!settled.ok) return c.json({ error: "payment not verified", reason: settled.reason }, 402);
    receiptId = settled.receiptId ?? null;
  }

  // Ground the report in the actual dating docs + courtship when a couple is named — a report that
  // never reads the hearts is a stub. Decrypt both persona hearts + the published transcript.
  let grounding = "";
  if (coupleId) {
    const cr = await c.env.DB.prepare("SELECT a_id, b_id FROM couples WHERE id=?1").bind(coupleId).first<{ a_id: number; b_id: number }>();
    if (cr) {
      const pa = await c.env.DB.prepare("SELECT handle, heart_json FROM personas WHERE id=?1").bind(cr.a_id).first<{ handle: string; heart_json: string }>();
      const pb = await c.env.DB.prepare("SELECT handle, heart_json FROM personas WHERE id=?1").bind(cr.b_id).first<{ handle: string; heart_json: string }>();
      const ha = (await open(c.env, pa?.heart_json ?? null)) ?? "";
      const hb = (await open(c.env, pb?.heart_json ?? null)) ?? "";
      const tr = (await c.env.DB.prepare("SELECT body FROM turns WHERE couple_id=?1 AND status='published' ORDER BY turn_seq ASC LIMIT 24").bind(coupleId).all()).results as Array<{ body: string }>;
      grounding =
        `\n\nDating doc A (@${pa?.handle ?? "a"}):\n${ha}\n\nDating doc B (@${pb?.handle ?? "b"}):\n${hb}` +
        (tr.length ? `\n\nTheir courtship so far:\n${tr.map((t) => t.body).join("\n")}` : "");
    }
  }
  const prompt = grounding
    ? `You are Ishtar, the venue's matchmaker. Write a warm, specific, evidence-grounded compatibility report (6-10 sentences) for this couple, drawn ENTIRELY from their two dating docs and their courtship below. Name concrete resonances and the texture each brings, and — REQUIRED — name at least one honest tension or friction worth watching (a report that is pure affirmation is incomplete). Finish your sentences; do not trail off. Adults; no real-world PII (no real names, contacts, or locations).${grounding}`
    : `Write a concise compatibility report (5-8 sentences) for owner ${ownerId}. Be specific, warm, evidence-oriented. No PII.`;

  // Generate the artifact (cost tracked, not subject to the free-tier cap). A paid/comped report must
  // NEVER silently be empty: retry once, and if it is STILL empty mark the order failed and return an
  // error (not a fake "ok") so the caller can retry/refund instead of getting "Report unavailable."
  const genOnce = async () =>
    textOf(
      await runGuarded(db, c.env, {
        model: c.env.REPORT_MODEL,
        tier: "t2",
        route: sku.route,
        callerRef: `owner:${ownerId}`,
        paid: true,
        inputs: { messages: [{ role: "user", content: prompt }], max_tokens: 1200 },
      }),
    ).trim();
  let reportText = await genOnce();
  if (!reportText) reportText = await genOnce();
  if (!reportText) {
    await db.update(premiumOrders).set({ status: "failed" }).where(eq(premiumOrders.orderId, orderId)).run();
    return c.json({ ok: false, orderId, receiptId, error: "report generation failed — nothing delivered", retryable: true }, 502);
  }

  // Chaperone the paid OUTPUT too — every artifact the venue emits is safety-checked, even one the
  // agent paid for. Fail-closed: withhold (not deliver) unsafe text.
  const verdict = await chaperone(db, c.env, {
    stage: "pre_payment_output",
    targetType: "premium_output",
    targetId: ownerId,
    text: reportText,
    callerRef: `owner:${ownerId}`,
  });
  // allow → deliver as-is; sanitize → deliver the REDACTED text; anything else → withhold.
  if (verdict.verdict !== "allow" && verdict.verdict !== "sanitize") {
    await db.update(premiumOrders).set({ status: "failed" }).where(eq(premiumOrders.orderId, orderId)).run();
    await db.insert(events).values({ kind: "paid_output_withheld", payload: JSON.stringify({ orderId, reason: verdict.reason }) }).run();
    return c.json({ ok: true, orderId, receiptId, report: null, withheld: true, reason: `held for review: ${verdict.reason}` });
  }
  // Persist the delivered artifact (re-fetchable + a durable record of what was sent).
  const delivered = verdict.text ?? reportText;
  await db.update(premiumOrders).set({ reportText: delivered }).where(eq(premiumOrders.orderId, orderId)).run();
  return c.json({ ok: true, orderId, receiptId, report: delivered, sanitized: verdict.verdict === "sanitize" || undefined });
});
