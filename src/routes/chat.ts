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
import { egressFilter } from "../xmtp/egress";
import { ishtarReply, looksLikeSystemLeak, ISHTAR_PROMPT_ANCHORS, type ChatMode } from "../chat/ishtar";
import { crisisResponse, detectCrisis, recordCrisisEvent } from "../safety/crisis";
import { MINOR_REDIRECT, detectMinor, recordMinorEvent } from "../safety/age";
import { db as makeDb } from "../db/client";
import { chatMessages, chatTopups } from "../db/schema";
import type { Env } from "../env";
import {
  addCredits,
  affirms18Plus,
  attest18,
  chargeOne,
  isAdultAttested,
  consumeNonce,
  creditsPerUsd,
  getBalance,
  mintNonce,
  mintSession,
  resolveSession,
} from "../economics/chatcredits";
import { accrueBuyback } from "../economics/reserve";
import { recordEpisode, recordFeedback } from "../coach/memory";
import { makeX402Provider, SKUS, x402Challenge } from "../payments/x402";
import { timingSafeEqualStr } from "../util/timing";

export const chatRoutes = new Hono<{ Bindings: Env }>();

const bearer = (auth?: string): string | undefined =>
  auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined;

// Pre-launch access gate: during the closed test only whitelisted wallets get a real coaching reply;
// everyone else gets a friendly "opens soon". Flip CHAT_LAUNCHED=true (env, no redeploy if read live) at
// launch to open to all. The founder wallet (gokhan.eth) is ALWAYS allowed; CHAT_WHITELIST adds more.
const FOUNDER_WALLET = "0x36de990133d36d7e3df9a820aa3ede5a2320de71"; // gokhan.eth — pre-launch tester
const PRELAUNCH_REPLY =
  "Ishtar Talk is in a closed test right now — it opens to everyone soon. You're early: join the list at " +
  "ishtar.numetal.xyz/subscribe and I'll be right here when the doors open.";
export function chatOpenFor(env: Env, address: string): boolean {
  if (env.CHAT_LAUNCHED === "true" || env.CHAT_LAUNCHED === "1") return true; // launched → everyone
  const wl = new Set([FOUNDER_WALLET]);
  if (env.CHAT_WHITELIST) for (const a of env.CHAT_WHITELIST.split(",")) {
    const t = a.trim().toLowerCase();
    if (t) wl.add(t);
  }
  return wl.has(address.toLowerCase());
}

/* ---- 1) session via wallet signature (free path) ----------------------------------------- */
// The client signs a short message that NAMES the venue and carries a recent ISO timestamp;
// we verify the signature recovers to the claimed address (viem) and that the message is fresh.
const sessionSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  message: z.string().min(20).max(600),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

// Mint a single-use sign-in nonce (anti-replay). The client embeds it in the signed message.
chatRoutes.get("/chat/nonce", async (c) => {
  const nonce = await mintNonce(makeDb(c.env.DB));
  return c.json({ nonce, expiresInSeconds: 600 });
});

chatRoutes.post("/chat/session", async (c) => {
  const parsed = sessionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "address, message, signature required" }, 400);
  const { address, message, signature } = parsed.data;
  if (!message.includes("ishtar.numetal.xyz")) return c.json({ error: "message must reference ishtar.numetal.xyz" }, 400);
  const issued = message.match(/(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/)?.[1];
  if (!issued || Math.abs(Date.now() - new Date(issued).getTime()) > 10 * 60_000)
    return c.json({ error: "message must include an ISO-8601 timestamp issued within 10 minutes" }, 400);
  const nonce = message.match(/nonce:\s*([a-f0-9]{16,})/i)?.[1];
  if (!nonce) return c.json({ error: "message must include a server nonce — GET /api/chat/nonce first" }, 400);
  // Adults-only: the signed message must affirm 18+. Because it's part of the signed payload, the
  // attestation is cryptographically bound to the wallet — not a spoofable checkbox.
  if (!affirms18Plus(message)) return c.json({ error: "message must affirm you are 18 or older (include \"18+\")" }, 400);
  let valid = false;
  try {
    valid = await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` });
  } catch {
    valid = false;
  }
  if (!valid) return c.json({ error: "signature does not match address" }, 401);

  const db = makeDb(c.env.DB);
  // Consume the nonce only after the signature checks out → single-use, replay-proof.
  if (!(await consumeNonce(db, nonce))) return c.json({ error: "nonce invalid, expired, or already used — request a new one" }, 401);
  await attest18(db, address); // signed 18+ affirmation → recorded
  const { token, expiresAt } = await mintSession(db, address, "signature");
  return c.json({ ok: true, sessionToken: token, expiresAt, address: address.toLowerCase(), ...(await getBalance(db, c.env, address)) });
});

/* ---- 2) top up credits with x402 (USDC on Base) ------------------------------------------ */
const topupSchema = z.object({ ref: z.string().min(8).max(100), over18: z.boolean().optional() });

chatRoutes.post("/chat/topup", async (c) => {
  const parsed = topupSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "ref (client idempotency key, 8-100 chars) required" }, 400);
  if (!parsed.data.over18) return c.json({ error: "over18:true required — you must confirm you are 18 or older" }, 400);
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
      nonce: v.nonce,
      settlementTx: v.tx,
    })
    .onConflictDoNothing()
    .returning({ id: chatTopups.id })
    .get();
  if (first) {
    await addCredits(db, v.payer, credits);
    await accrueBuyback(db, c.env, null, dollars); // chat has no premium_orders row → null order ref
  }
  await attest18(db, v.payer); // over18 confirmed above → recorded
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
  // Binding adults-only check: a recorded 18+ attestation is required to send (closes pre-attestation
  // accounts + makes the attestation enforced, not just logged). Re-attest by minting a fresh session.
  if (!(await isAdultAttested(db, address)))
    return c.json({ error: "confirm you are 18 or older — start a new session", reattest: true }, 403);

  const parsed = chatSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "message (1-2000 chars) required" }, 400);
  const mode: ChatMode = parsed.data.mode ?? "chat";
  const { message } = parsed.data;

  // (a0) CRISIS short-circuit — deterministic, runs BEFORE charge/model/classifier so a person in
  // crisis is never coached-through nor cold-blocked. Free; returns a vetted resource response and a
  // `safety:"crisis_support"` flag. NOT captured as a coach episode (crisis ≠ lovemap data).
  const crisis = detectCrisis(message);
  if (crisis.hit) {
    const care = crisisResponse(c.req.header("cf-ipcountry") || undefined);
    await recordCrisisEvent(db, `chat:${address}`, crisis);
    await db.insert(chatMessages).values({ address, role: "user", body: message, mode }).run();
    await db.insert(chatMessages).values({ address, role: "assistant", body: care, mode }).run();
    return c.json({ ok: true, reply: care, mode, via: "crisis", safety: "crisis_support", ...(await getBalance(db, c.env, address)) });
  }

  // (a0b) MINOR short-circuit — deterministic, adults-only venue. Self-disclosed under-18 gets a kind
  // "adults only" redirect, never coaching. No charge, no stored history, operator-flagged. (Undisclosed
  // age is handled by the binding Didit identity check before any real-world meeting, not here.)
  if (detectMinor(message)) {
    await recordMinorEvent(db, `chat:${address}`);
    return c.json({ ok: true, reply: MINOR_REDIRECT, mode, via: "age_gate", safety: "adults_only", ...(await getBalance(db, c.env, address)) });
  }

  // (a0c) PRE-LAUNCH gate — closed test: only whitelisted wallets get a real coaching reply; everyone
  // else gets a friendly "opens soon" (safety layers above still run for all). No charge, no model.
  if (!chatOpenFor(c.env, address)) {
    return c.json({ ok: true, reply: PRELAUNCH_REPLY, mode, via: "prelaunch", ...(await getBalance(db, c.env, address)) });
  }

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

  // (d) OUTPUT defenses, ALL fail-closed and independent of each other:
  //   1. egress scrub — deterministic redaction of secret shapes (API keys / JWT / seeds / hex /
  //      base64 / NAME=secret) and verbatim system-prompt fragments. Independent of the model AND of
  //      the safety classifier (Llama-Guard won't flag a leaked key as "unsafe"). Any hit → withhold.
  //   2. looksLikeSystemLeak — fixed-anchor backstop for prompt-echo paraphrases.
  //   3. chaperone — Llama-Guard safety categories.
  const egress = egressFilter(reply, ISHTAR_PROMPT_ANCHORS);
  const leak = looksLikeSystemLeak(reply);
  const outV = await chaperone(db, c.env, { stage: "chat_output", targetType: "chat_output", targetId: 0, text: reply, callerRef: `chat:${address}` });
  const safeReply =
    egress.safe && !leak && (outV.verdict === "allow" || outV.verdict === "sanitize") ? outV.text ?? reply : null;
  const withholdReason = !egress.safe
    ? `withheld: secret/prompt leak (${egress.hits.join(",")})`
    : leak
      ? "withheld: instruction disclosure"
      : outV.reason;

  await db.insert(chatMessages).values({ address, role: "user", body: message, mode }).run();
  if (safeReply) await db.insert(chatMessages).values({ address, role: "assistant", body: safeReply, mode }).run();

  // Phase 0 — capture the coaching exchange as an episode (the compounding moat data).
  // Best-effort: never break the reply over a capture write.
  if (safeReply) {
    try {
      await recordEpisode(db, { subject: address, kind: "advice", content: `Q: ${message}\nA: ${safeReply}`, importance: mode === "coach" ? 0.6 : 0.4 });
    } catch {
      /* capture is best-effort */
    }
  }

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

/* ---- 5) feedback → discount (Phase 0 capture) — HUMANS ONLY ------------------------------- */
// A rating or (high-signal) date debrief earns chat credits AND mints an episode. The discount
// buys the proprietary "what actually landed" data the moat needs; awards are capped per day.
const feedbackSchema = z.object({
  kind: z.enum(["rating", "debrief"]),
  rating: z.number().int().min(1).max(5).optional(),
  body: z.string().max(4000).optional(),
});

chatRoutes.post("/chat/feedback", async (c) => {
  const token = bearer(c.req.header("authorization"));
  if (!token) return c.json({ error: "missing bearer session" }, 401);
  const db = makeDb(c.env.DB);
  const address = await resolveSession(db, token);
  if (!address) return c.json({ error: "invalid or expired session" }, 401);
  // Same binding adults-only gate as POST /chat — no credit-earning without a recorded 18+ attestation.
  if (!(await isAdultAttested(db, address)))
    return c.json({ error: "confirm you are 18 or older — start a new session", reattest: true }, 403);

  const parsed = feedbackSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "kind (rating|debrief) required" }, 400);
  const { kind, rating, body } = parsed.data;
  if (kind === "rating" && !rating) return c.json({ error: "rating (1-5) required" }, 400);
  if (kind === "debrief" && (!body || body.trim().length < 40))
    return c.json({ error: "a debrief needs at least 40 characters — tell Ishtar what actually happened" }, 400);

  // Crisis short-circuit — a date debrief can carry a self-harm disclosure. Care over capture: no
  // award, no episode, return the vetted resource response. Same deterministic layer as /chat.
  if (body) {
    const cr = detectCrisis(body);
    if (cr.hit) {
      await recordCrisisEvent(db, `feedback:${address}`, cr);
      const care = crisisResponse(c.req.header("cf-ipcountry") || undefined);
      return c.json({ ok: true, kind, creditsAwarded: 0, safety: "crisis_support", reply: care, ...(await getBalance(db, c.env, address)) });
    }
    if (detectMinor(body)) {
      await recordMinorEvent(db, `feedback:${address}`);
      return c.json({ ok: true, kind, creditsAwarded: 0, safety: "adults_only", reply: MINOR_REDIRECT, ...(await getBalance(db, c.env, address)) });
    }
  }

  // Chaperone the free-text IN (fail-closed) before storing — it is user content.
  if (body) {
    const v = await chaperone(db, c.env, { stage: "chat_input", targetType: "chat_input", targetId: 0, text: body, callerRef: `feedback:${address}` });
    if (v.verdict !== "allow" && v.verdict !== "sanitize") return c.json({ error: "feedback held by the chaperone", reason: v.reason }, 422);
  }

  const { awarded } = await recordFeedback(db, { subject: address, kind, rating, body });
  return c.json({ ok: true, kind, creditsAwarded: awarded, ...(await getBalance(db, c.env, address)) });
});

/* ---- 6) founder grant (ACCESS_KEY) — issue a session + credits for testing/comps ---------- */
const grantSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  credits: z.number().int().min(0).max(10000).optional(),
});

chatRoutes.post("/chat/admin/grant", async (c) => {
  const tok = bearer(c.req.header("authorization"));
  if (!c.env.ACCESS_KEY || !tok || !(await timingSafeEqualStr(tok, c.env.ACCESS_KEY)))
    return c.json({ error: "founder only" }, 403);
  const parsed = grantSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "bad body" }, 400);
  const db = makeDb(c.env.DB);
  const address = (parsed.data.address ?? "0x000000000000000000000000000000000000dEaD").toLowerCase();
  const credits = parsed.data.credits ?? 50;
  await addCredits(db, address, credits);
  await attest18(db, address); // founder grant (testing/comps) — attested
  const { token, expiresAt } = await mintSession(db, address, "admin");
  return c.json({ ok: true, address, granted: credits, sessionToken: token, expiresAt, ...(await getBalance(db, c.env, address)) });
});
