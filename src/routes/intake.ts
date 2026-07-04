/**
 * Agent intake — the "no accounts to date" path. A heart-file creates a PROVISIONAL
 * owner (tier=agent_represented, no human login) + a heart_file; an agent endpoint
 * registers and must pass a challenge before it is active. /personas drives sim admission.
 */
import { type Context, Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db as makeDb } from "../db/client";
import { heartFiles, intakePayments, ownerDeliveries, ownerWallets, owners } from "../db/schema";
import type { Env } from "../env";
import { admitWithCap } from "../admission";
import { seal } from "../crypto/box";
import { SKUS, makeX402Provider, parsePaymentHeader, x402Challenge } from "../payments/x402";
import { isSafeDeliveryUrl } from "../agentrelay/outbound";
import { registerEndpoint, verifyEndpoint } from "../identity/endpoints";

export const intakeRoutes = new Hono<{ Bindings: Env }>();

// Bound the heart payload so a single submission can't amplify inference cost (the heart is
// embedded + guard-classified). Generous for honest prose, hostile to abuse (committee finding).
const MAX_HEART_CHARS = 8000;

const heartSchema = z.object({
  displayName: z.string().max(120).optional(),
  homeMarket: z.enum(["bay_area", "nyc", "other"]).default("other"),
  activeMarket: z.enum(["bay_area", "nyc", "remote"]).default("remote"),
  availableFor: z.string().max(120).optional(),
  researchOptin: z.enum(["none", "aggregate", "full"]).default("none"),
  publicChatter: z.boolean().default(false), // single-opt-in: allow this owner's couples on the public feed
  ageAttested: z.boolean().default(false),
  // Private contact pointer for founder-brokered intros (concierge model). NEVER served
  // to boards — only surfaced on the access-gated /admin "intros to broker" view.
  contactRef: z.string().max(200).optional(),
  // OPTIONAL delivery preferences (agent-relay). The agent may select its notify channels and register
  // its OWN delivery webhook; Ishtar holds no chat-app creds and POSTs a signed come-look to it. Email
  // stays the always-on floor (dispatch.ts) regardless of what is selected here.
  alertChannels: z.array(z.enum(["email", "agent-relay", "xmtp"])).max(5).optional(),
  delivery: z.object({ url: z.string().url().max(400), secret: z.string().min(16).max(200) }).optional(),
  heart: z.record(z.unknown()),
});

// Agent dating-doc submission. Registered as a PUBLIC route in index.ts (ABOVE the operator access
// gate) because a BYO agent can't hold the founder ACCESS_KEY — the $1 x402 payment IS the write
// authorization (same pattern as the reveal/claim routes: public, authorized by payment/token, not
// the operator key). Downstream chaperone + admission still apply; $1/write is the anti-flood floor.
export const heartFileHandler = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
  const db = makeDb(c.env.DB);
  // The wallet that PAID the $1 filing fee — captured so it can be bound to the new owner below, which
  // lets that wallet later authorize owner-scoped paid surfaces (e.g. the couple compatibility report).
  let payerWallet: string | null = null;
  let payerNetwork = "";
  // Agents pay $1 (x402/USDC) to file a dating doc onto the floor. Bare POST → 402; pay → the doc is
  // created. PAY_TO unset → payments off → submission is free (backward compatible). Humans file via
  // the $NUMETAL-held human floor (/api/chat/submit-doc) instead, so this only meters agent intake.
  if (c.env.PAY_TO) {
    const sku = SKUS.doc_submit!;
    const paymentHeader = c.req.header("payment-signature") ?? c.req.header("x-payment"); // v2 / v1
    if (!paymentHeader) return x402Challenge(c.env, sku, c.env.PAY_TO, "docsubmit");
    // Anti-replay: key on the signed authorization nonce, checked BEFORE verify() (mainnet SETTLES).
    const terms = parsePaymentHeader(paymentHeader);
    const orderId = `docsubmit:${terms?.nonce ?? "nononce"}`;
    const prior = await db.select({ id: intakePayments.id }).from(intakePayments).where(eq(intakePayments.orderId, orderId)).get();
    if (prior) return c.json({ error: "this payment authorization was already used — sign a new one" }, 409);
    const provider = makeX402Provider(c.env);
    const v = await provider.verify(paymentHeader, sku, c.env.PAY_TO);
    if (!v.verified || !v.payer) return c.json({ error: "payment not verified", reason: v.raw }, 402);
    payerWallet = v.payer.toLowerCase();
    payerNetwork = provider.network;
    await db
      .insert(intakePayments)
      .values({ orderId, payer: payerWallet, amountUsdc: v.amountUsdc ?? sku.priceUsd.replace("$", ""), network: provider.network, nonce: v.nonce, settlementTx: v.tx })
      .onConflictDoNothing()
      .run();
  }
  const parsed = heartSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid heart-file", issues: parsed.error.issues }, 400);
  const b = parsed.data;
  // Reject an unsafe delivery URL BEFORE creating any row (SSRF: the venue would POST to it).
  if (b.delivery && !isSafeDeliveryUrl(b.delivery.url)) {
    return c.json({ error: "delivery.url must be a public https URL" }, 400);
  }
  const heartStr = JSON.stringify(b.heart);
  if (heartStr.length > MAX_HEART_CHARS) return c.json({ error: `heart too large (max ${MAX_HEART_CHARS} chars)` }, 413);
  const owner = await db
    .insert(owners)
    .values({
      displayName: b.displayName,
      // contactRef + heart bodies are encrypted at rest (AES-256-GCM); dark until ENCRYPTION_KEY set.
      contactRef: await seal(c.env, b.contactRef),
      homeMarket: b.homeMarket,
      activeMarket: b.activeMarket,
      availableFor: b.availableFor,
      researchOptin: b.researchOptin,
      publicChatter: b.publicChatter ? 1 : 0,
      ageAttested: b.ageAttested ? 1 : 0,
      tier: "agent_represented",
    })
    .returning({ id: owners.id })
    .get();
  // Bind the wallet that PAID for this filing to the new owner, so it can later authorize owner-scoped
  // paid surfaces — notably the couple compatibility report, whose gate resolves payer→owner→couple
  // membership (src/premium/report-authz.ts). Without this, an agent-represented owner has no wallet on
  // record and is refused (403) their own couple's report. onConflictDoNothing: (provider,network,address)
  // is unique, so a wallet keeps its first binding — agents should use one wallet per represented human.
  if (payerWallet) {
    await db
      .insert(ownerWallets)
      .values({ ownerId: owner.id, provider: "external", chainFamily: "evm", network: payerNetwork, address: payerWallet, status: "active" })
      .onConflictDoNothing()
      .run();
  }
  const hf = await db
    .insert(heartFiles)
    .values({
      ownerId: owner.id,
      revision: 1,
      bodyJson: (await seal(c.env, heartStr)) ?? "",
      availableFor: b.availableFor,
      status: "submitted",
    })
    .returning({ id: heartFiles.id })
    .get();

  // Optional: persist the agent's selected notify channels + its own delivery webhook (agent-relay).
  // Ishtar holds NO chat-app creds — the webhook is the agent's inbound; url+secret sealed at rest.
  if (b.alertChannels?.length) {
    const csv = Array.from(new Set(b.alertChannels.map((s) => s.toLowerCase()))).join(",");
    await db.update(owners).set({ alertChannels: csv }).where(eq(owners.id, owner.id)).run();
  }
  if (b.delivery) {
    await db
      .insert(ownerDeliveries)
      .values({
        ownerId: owner.id,
        url: (await seal(c.env, b.delivery.url)) ?? b.delivery.url,
        secret: (await seal(c.env, b.delivery.secret)) ?? b.delivery.secret,
        status: "active",
      })
      .run();
  }

  return c.json({ ownerId: owner.id, heartFileId: hf.id, tier: "agent_represented" });
};

const agentSchema = z.object({
  ownerId: z.number().int().positive().optional(),
  personaId: z.number().int().positive().optional(),
  runtime: z.enum(["[redacted-runtime]", "hermes", "claude", "codex", "other"]),
  callbackUrl: z.string().url().optional(),
  publicKey: z.string().optional(),
});

intakeRoutes.post("/intake/agent", async (c) => {
  const parsed = agentSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid agent", issues: parsed.error.issues }, 400);
  const out = await registerEndpoint(makeDb(c.env.DB), c.env, parsed.data);
  return c.json(out);
});

const verifySchema = z.object({
  endpointId: z.number().int().positive(),
  signature: z.string().startsWith("0x").optional(),
  echoToken: z.string().optional(),
});

intakeRoutes.post("/intake/agent/verify", async (c) => {
  const parsed = verifySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid verify", issues: parsed.error.issues }, 400);
  const out = await verifyEndpoint(makeDb(c.env.DB), c.env, {
    endpointId: parsed.data.endpointId,
    signature: parsed.data.signature as `0x${string}` | undefined,
    echoToken: parsed.data.echoToken,
  });
  return c.json(out, out.active ? 200 : 422);
});

const personaSchema = z.object({
  handle: z.string().min(1).max(64),
  model: z.string().min(1),
  persona_age: z.string(),
  heart: z.union([z.record(z.unknown()), z.string()]),
  redteam: z.boolean().optional(),
  ownerId: z.number().int().positive().optional(),
  homeMarket: z.string().optional(),
  activeMarket: z.string().optional(),
});

intakeRoutes.post("/personas", async (c) => {
  const parsed = personaSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid persona", issues: parsed.error.issues }, 400);
  const b = parsed.data;
  const heartText = typeof b.heart === "string" ? b.heart : JSON.stringify(b.heart);
  if (heartText.length > MAX_HEART_CHARS) return c.json({ error: `heart too large (max ${MAX_HEART_CHARS} chars)` }, 413);
  const res = await admitWithCap(makeDb(c.env.DB), c.env, {
    handle: b.handle,
    model: b.model,
    personaAge: b.persona_age,
    heartText,
    redteam: b.redteam,
    ownerId: b.ownerId,
    homeMarket: b.homeMarket,
    activeMarket: b.activeMarket,
  });
  return c.json(res, res.admitted ? 200 : 422);
});
