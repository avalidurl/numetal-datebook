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

  const paymentHeader = c.req.header("x-payment");
  if (!paymentHeader) {
    await db
      .update(premiumOrders)
      .set({ status: "challenged" })
      .where(eq(premiumOrders.orderId, orderId))
      .run();
    return x402Challenge({ sku, network: provider.network, payTo: c.env.PAY_TO, orderId });
  }

  const settled = await settleAndPersist(db, c.env, provider, { orderId, sku, payTo: c.env.PAY_TO }, paymentHeader);
  if (!settled.ok) return c.json({ error: "payment not verified", reason: settled.reason }, 402);

  // Paid → generate the artifact (cost tracked, but not subject to the free-tier budget cap).
  const result = await runGuarded(db, c.env, {
    model: c.env.REPORT_MODEL,
    tier: "t2",
    route: sku.route,
    callerRef: `owner:${ownerId}`,
    paid: true,
    inputs: {
      messages: [
        {
          role: "user",
          content: `Write a concise compatibility report (5-8 sentences) for owner ${ownerId}${
            coupleId ? ` and couple ${coupleId}` : ""
          }. Be specific, warm, evidence-oriented. No PII.`,
        },
      ],
      max_tokens: 600,
    },
  });
  const reportText = textOf(result) || "Report unavailable.";

  // Chaperone the paid OUTPUT too — every artifact the venue emits is safety-checked,
  // even one the agent paid for. Fail-closed: withhold (not deliver) unsafe text.
  const verdict = await chaperone(db, c.env, {
    stage: "pre_payment_output",
    targetType: "premium_output",
    targetId: ownerId,
    text: reportText,
    callerRef: `owner:${ownerId}`,
  });
  // allow → deliver as-is; sanitize → deliver the REDACTED text; anything else → withhold.
  if (verdict.verdict !== "allow" && verdict.verdict !== "sanitize") {
    await db.insert(events).values({ kind: "paid_output_withheld", payload: JSON.stringify({ orderId, reason: verdict.reason }) }).run();
    return c.json({ ok: true, orderId, receiptId: settled.receiptId, report: null, withheld: true, reason: `held for review: ${verdict.reason}` });
  }
  return c.json({
    ok: true,
    orderId,
    receiptId: settled.receiptId,
    report: verdict.text ?? reportText,
    sanitized: verdict.verdict === "sanitize" || undefined,
  });
});
