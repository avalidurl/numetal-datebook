/**
 * Talk-to-Ishtar — public, self-authenticated chat (NO venue access key; geo-gated). Auth is a
 * bearer SESSION token obtained by either proving wallet control (signature → free $NUMETAL
 * quota) or paying (x402 top-up → credits). Every message is chaperoned IN and OUT, fail-closed.
 * Mounted before the operator access gate; the founder-grant route gates itself on ACCESS_KEY.
 */
import { Hono } from "hono";
import { verifyMessage } from "viem";
import { z } from "zod";
import { chaperone } from "../chaperone";
import { ishtarReply, looksLikeSystemLeak, type ChatMode } from "../chat/ishtar";
import { db as makeDb } from "../db/client";
import { chatMessages, chatTopups } from "../db/schema";
import type { Env } from "../env";
import {
  addCredits,
  chargeOne,
  creditsPerUsd,
  getBalance,
  mintSession,
  resolveSession,
} from "../economics/chatcredits";
import { accrueBuyback } from "../economics/reserve";
import { makeX402Provider, SKUS, x402Challenge } from "../payments/x402";

export const chatRoutes = new Hono<{ Bindings: Env }>();

const bearer = (auth?: string): string | undefined =>
  auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined;

/* ---- 1) session via wallet signature (free path) ----------------------------------------- */
// The client signs a short message that NAMES the venue and carries a recent ISO timestamp;
// we verify the signature recovers to the claimed address (viem) and that the message is fresh.
const sessionSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  message: z.string().min(20).max(600),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

chatRoutes.post("/chat/session", async (c) => {
  const parsed = sessionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "address, message, signature required" }, 400);
  const { address, message, signature } = parsed.data;
  if (!message.includes("ishtar.numetal.xyz")) return c.json({ error: "message must reference ishtar.numetal.xyz" }, 400);
  const issued = message.match(/(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/)?.[1];
  if (!issued || Math.abs(Date.now() - new Date(issued).getTime()) > 10 * 60_000)
    return c.json({ error: "message must include an ISO-8601 timestamp issued within 10 minutes" }, 400);
  let valid = false;
  try {
    valid = await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` });
  } catch {
    valid = false;
  }
  if (!valid) return c.json({ error: "signature does not match address" }, 401);

  const db = makeDb(c.env.DB);
  const { token, expiresAt } = await mintSession(db, address, "signature");
  return c.json({ ok: true, sessionToken: token, expiresAt, address: address.toLowerCase(), ...(await getBalance(db, c.env, address)) });
});

/* ---- 2) top up credits with x402 (USDC on Base) ------------------------------------------ */
const topupSchema = z.object({ ref: z.string().min(8).max(100) });

chatRoutes.post("/chat/topup", async (c) => {
  const parsed = topupSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "ref (client idempotency key, 8-100 chars) required" }, 400);
  if (!c.env.PAY_TO) return c.json({ error: "payments not configured" }, 503);
  if (c.env.X402_MODE === "mainnet") return c.json({ error: "mainnet x402 not yet wired — see DEPLOY.md" }, 503);

  const sku = SKUS.chat_topup!;
  const provider = makeX402Provider(c.env);
  const orderId = `chattopup:${parsed.data.ref}`;
  const paymentHeader = c.req.header("x-payment");
  if (!paymentHeader) return x402Challenge({ sku, network: provider.network, payTo: c.env.PAY_TO, orderId });

  const v = await provider.verify(paymentHeader, sku, c.env.PAY_TO);
  if (!v.verified || !v.payer) return c.json({ error: "payment not verified", reason: v.raw }, 402);

  const db = makeDb(c.env.DB);
  const dollars = Number(sku.priceUsd.replace("$", ""));
  const credits = creditsPerUsd(c.env) * dollars;
  // Idempotent settle: first insert wins; a replay credits nothing twice.
  const first = await db
    .insert(chatTopups)
    .values({
      orderId,
      payer: v.payer.toLowerCase(),
      amountUsdc: v.amountUsdc ?? String(dollars),
      credits,
      network: provider.network,
      settlementTx: v.tx,
    })
    .onConflictDoNothing()
    .returning({ id: chatTopups.id })
    .get();
  if (first) {
    await addCredits(db, v.payer, credits);
    await accrueBuyback(db, c.env, null, dollars); // chat has no premium_orders row → null order ref
  }
  const { token, expiresAt } = await mintSession(db, v.payer, "topup");
  return c.json({ ok: true, credited: !!first, sessionToken: token, expiresAt, address: v.payer.toLowerCase(), ...(await getBalance(db, c.env, v.payer)) });
});

/* ---- 3) chat (bearer session) ------------------------------------------------------------ */
const chatSchema = z.object({ message: z.string().min(1).max(2000), mode: z.enum(["chat", "coach"]).optional() });

chatRoutes.post("/chat", async (c) => {
  const token = bearer(c.req.header("authorization"));
  if (!token) return c.json({ error: "missing bearer session — POST /api/chat/session or /api/chat/topup first" }, 401);
  const db = makeDb(c.env.DB);
  const address = await resolveSession(db, token);
  if (!address) return c.json({ error: "invalid or expired session" }, 401);

  const parsed = chatSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "message (1-2000 chars) required" }, 400);
  const mode: ChatMode = parsed.data.mode ?? "chat";
  const { message } = parsed.data;

  // (a) chaperone the human's input BEFORE charging — a blocked message costs nothing. Fail-closed.
  const inV = await chaperone(db, c.env, { stage: "chat_input", targetType: "chat_input", targetId: 0, text: message, callerRef: `chat:${address}` });
  if (inV.verdict !== "allow" && inV.verdict !== "sanitize")
    return c.json({ error: "message held by the chaperone", reason: inV.reason }, 422);

  // (b) spend a free-quota message or a paid credit; 402 if neither.
  const charge = await chargeOne(db, c.env, address);
  if (!charge.ok) return c.json({ error: "no credits — top up to keep talking", balance: charge.balance, topup: "/api/chat/topup" }, 402);

  // (c) generate, refunding a paid credit if the model/gateway fails.
  let reply: string;
  try {
    reply = await ishtarReply(db, c.env, { address, message, mode });
  } catch {
    if (charge.via === "paid") await addCredits(db, address, 1);
    return c.json({ error: "Ishtar is resting — try again shortly." }, 503);
  }

  // (d) chaperone the OUTPUT (fail-closed): withhold anything not allow/sanitize, AND withhold a
  // reply that leaks the system prompt (a confidentiality leak the safety classifier won't flag).
  const leak = looksLikeSystemLeak(reply);
  const outV = await chaperone(db, c.env, { stage: "chat_output", targetType: "chat_output", targetId: 0, text: reply, callerRef: `chat:${address}` });
  const safeReply = !leak && (outV.verdict === "allow" || outV.verdict === "sanitize") ? outV.text ?? reply : null;
  const withholdReason = leak ? "withheld: instruction disclosure" : outV.reason;

  await db.insert(chatMessages).values({ address, role: "user", body: message, mode }).run();
  if (safeReply) await db.insert(chatMessages).values({ address, role: "assistant", body: safeReply, mode }).run();

  if (!safeReply) return c.json({ ok: true, reply: null, withheld: true, reason: withholdReason, via: charge.via, balance: charge.balance });
  return c.json({ ok: true, reply: safeReply, mode, via: charge.via, balance: charge.balance });
});

/* ---- 4) balance -------------------------------------------------------------------------- */
chatRoutes.get("/chat/balance", async (c) => {
  const token = bearer(c.req.header("authorization"));
  if (!token) return c.json({ error: "missing bearer session" }, 401);
  const db = makeDb(c.env.DB);
  const address = await resolveSession(db, token);
  if (!address) return c.json({ error: "invalid or expired session" }, 401);
  return c.json({ address, ...(await getBalance(db, c.env, address)) });
});

/* ---- 5) founder grant (ACCESS_KEY) — issue a session + credits for testing/comps ---------- */
const grantSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  credits: z.number().int().min(0).max(10000).optional(),
});

chatRoutes.post("/chat/admin/grant", async (c) => {
  const tok = bearer(c.req.header("authorization"));
  if (!c.env.ACCESS_KEY || tok !== c.env.ACCESS_KEY) return c.json({ error: "founder only" }, 403);
  const parsed = grantSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "bad body" }, 400);
  const db = makeDb(c.env.DB);
  const address = (parsed.data.address ?? "0x000000000000000000000000000000000000dEaD").toLowerCase();
  const credits = parsed.data.credits ?? 50;
  await addCredits(db, address, credits);
  const { token, expiresAt } = await mintSession(db, address, "admin");
  return c.json({ ok: true, address, granted: credits, sessionToken: token, expiresAt, ...(await getBalance(db, c.env, address)) });
});
