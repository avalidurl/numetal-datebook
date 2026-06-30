/**
 * Talk-to-Ishtar — public, self-authenticated chat (NO venue access key; geo-gated). Auth is a
 * bearer SESSION token obtained by either proving wallet control (signature → free $NUMETAL
 * quota) or paying (x402 top-up → credits). Every message is chaperoned IN and OUT, fail-closed.
 * Mounted before the operator access gate; the founder-grant route gates itself on ACCESS_KEY.
 */
import { Hono } from "hono";
import { verifyMessage } from "viem";
import { z } from "zod";
import { chaperone, type GuardFn } from "../chaperone";
import { egressFilter } from "../xmtp/egress";
import { ishtarReply, looksLikeSystemLeak, ISHTAR_PROMPT_ANCHORS, type ChatMode } from "../chat/ishtar";
import { crisisResponse, detectCrisis, recordCrisisEvent } from "../safety/crisis";
import { MINOR_REDIRECT, detectMinor, recordMinorEvent } from "../safety/age";
import { and, desc, eq } from "drizzle-orm";
import { db as makeDb, type DB } from "../db/client";
import { chatMessages, chatTopups, heartFiles, ownerWallets, owners } from "../db/schema";
import { seal } from "../crypto/box";
import { readNumetalUsd } from "../economics/numetal";
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
    // Sealed at rest (AES-GCM, dark until ENCRYPTION_KEY set) — a fat-fingered SSN/address in a crisis
    // message must not sit in D1 in the clear. Decrypted only on the history read in ishtarReply().
    await db.insert(chatMessages).values({ address, role: "user", body: (await seal(c.env, message)) ?? message, mode }).run();
    await db.insert(chatMessages).values({ address, role: "assistant", body: (await seal(c.env, care)) ?? care, mode }).run();
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

  // Sealed at rest (AES-GCM, dark until ENCRYPTION_KEY set). The body column is opaque in D1; the only
  // reader (ishtarReply history) decrypts via open(). Backward-compatible: legacy plaintext rows read as-is.
  await db.insert(chatMessages).values({ address, role: "user", body: (await seal(c.env, message)) ?? message, mode }).run();
  if (safeReply) await db.insert(chatMessages).values({ address, role: "assistant", body: (await seal(c.env, safeReply)) ?? safeReply, mode }).run();

  // Phase 0 — capture the coaching exchange as an episode (the compounding moat data).
  // Best-effort: never break the reply over a capture write.
  if (safeReply) {
    try {
      await recordEpisode(db, c.env, { subject: address, kind: "advice", content: `Q: ${message}\nA: ${safeReply}`, importance: mode === "coach" ? 0.6 : 0.4 });
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

  const { awarded } = await recordFeedback(db, c.env, { subject: address, kind, rating, body });
  return c.json({ ok: true, kind, creditsAwarded: awarded, ...(await getBalance(db, c.env, address)) });
});

/* ---- 5b) chat→floor bridge: "build your dating agent by talking to Ishtar" ----------------
 * A signed-in human (bearer session = wallet-bound + 18+ attested) submits the dating doc Ishtar
 * helped them draft. The human floor is PAID: the wallet must hold ≥ MIN_DOC_USD of $NUMETAL — a
 * READ-ONLY balance×price check (no funds move; same oracle the free-quota perk already uses). The
 * doc is chaperoned, sealed at rest, and bound to the wallet (owner_wallets). It is HELD pending
 * adult verification (Didit) — no persona is admitted to the floor and nothing reveals until the
 * founder funds + activates it, so a fresh submission is a soft-launch "ready in ~a day" hold.
 * IMPORTANT: this courts people's AGENTS, never people directly — surfaced to the human up front. */
const MAX_DOC_CHARS = 8000;
const HUMAN_FLOOR_NETWORK = "eip155:8453"; // Base mainnet — the wallet the human signed in with
const submitDocSchema = z.object({
  heart: z.record(z.unknown()), // the dating doc (matcher reads the optional structured `prefs` block)
  displayName: z.string().max(120).optional(),
  contactRef: z.string().max(200).optional(),
  email: z.string().email().max(200).optional(),
});

export interface SubmitDocInput {
  address: string;
  heart: Record<string, unknown>;
  displayName?: string;
  contactRef?: string;
  email?: string;
}

/**
 * Core of the chat→floor bridge — testable (guard injectable like admitWithCap). Returns an HTTP
 * {code, body}. Gates in order: 18+ attestation → paid $NUMETAL floor (read-only) → size → chaperone
 * (admission, fail-closed) → create/bind a HELD, wallet-bound owner + sealed heart revision.
 */
export async function submitDatingDoc(
  db: DB,
  env: Env,
  input: SubmitDocInput,
  deps?: { guard?: GuardFn },
): Promise<{ code: number; body: Record<string, unknown> }> {
  if (!(await isAdultAttested(db, input.address)))
    return { code: 403, body: { error: "confirm you are 18 or older — start a new session", reattest: true } };

  // PAID human floor: hold ≥ MIN_DOC_USD of $NUMETAL. Read-only balance×price (no funds move); a failed
  // read → 0 → gated. "0" disables (e.g. tests). Same oracle the free-quota perk already trusts.
  const minUsd = Number(env.MIN_DOC_USD ?? "50");
  if (minUsd > 0) {
    const { usdHeld } = await readNumetalUsd(input.address, { rpcUrl: env.BASE_RPC_URL, contract: env.NUMETAL_CA });
    if (usdHeld < minUsd)
      return {
        code: 402,
        body: { error: `the floor is paid — hold at least $${minUsd} of $NUMETAL to create a dating doc`, usdHeld: Math.round(usdHeld * 100) / 100, required: minUsd },
      };
  }

  const heartStr = JSON.stringify(input.heart);
  if (heartStr.length < 20) return { code: 400, body: { error: "your dating doc is too thin — tell Ishtar more about who you are and who you seek" } };
  if (heartStr.length > MAX_DOC_CHARS) return { code: 413, body: { error: `doc too large (max ${MAX_DOC_CHARS} chars)` } };

  // Chaperone the doc (admission stage, fail-closed) BEFORE it is stored or bound to anyone.
  const v = await chaperone(db, env, { stage: "admission", targetType: "heart_file", targetId: 0, text: heartStr, callerRef: `chatdoc:${input.address}` }, deps);
  if (v.verdict !== "allow" && v.verdict !== "sanitize")
    return { code: 422, body: { error: "your dating doc was held by the chaperone", reason: v.reason } };

  // One doc per wallet (idempotent): an existing wallet adds a heart revision instead of a duplicate.
  const bound = await db
    .select({ ownerId: ownerWallets.ownerId })
    .from(ownerWallets)
    .where(and(eq(ownerWallets.network, HUMAN_FLOOR_NETWORK), eq(ownerWallets.address, input.address)))
    .get();

  let ownerId: number;
  let revision = 1;
  const sealedContact = await seal(env, input.contactRef ?? input.email); // email/contact sealed at rest for the soft-launch notify
  if (bound?.ownerId) {
    ownerId = bound.ownerId;
    const last = await db.select({ revision: heartFiles.revision }).from(heartFiles).where(eq(heartFiles.ownerId, ownerId)).orderBy(desc(heartFiles.revision)).get();
    revision = (last?.revision ?? 0) + 1;
    if (sealedContact) await db.update(owners).set({ contactRef: sealedContact }).where(eq(owners.id, ownerId)).run();
  } else {
    const owner = await db
      .insert(owners)
      .values({
        displayName: input.displayName,
        contactRef: sealedContact,
        tier: "profile_claimed", // wallet-claimed; identity_verified comes after Didit
        ageAttested: 1, // bound 18+ from the signed-in chat session
        status: "pending", // HELD until adult-verification is funded + run
        homeMarket: "other",
        activeMarket: "remote",
        researchOptin: "none",
      })
      .returning({ id: owners.id })
      .get();
    ownerId = owner.id;
    await db.insert(ownerWallets).values({ ownerId, provider: "external", chainFamily: "evm", network: HUMAN_FLOOR_NETWORK, address: input.address }).onConflictDoNothing().run();
  }

  const hf = await db.insert(heartFiles).values({ ownerId, revision, bodyJson: (await seal(env, heartStr)) ?? "", status: "submitted" }).returning({ id: heartFiles.id }).get();

  return {
    code: 200,
    body: {
      ok: true,
      ownerId,
      heartFileId: hf.id,
      revision,
      status: "pending_verification",
      message:
        "Your dating doc is in and bound to your wallet. Your agent joins the courtship floor once we verify you're an adult — we'll write within about a day. Remember: here your agent flirts with other people's agents, never people directly.",
    },
  };
}

chatRoutes.post("/chat/submit-doc", async (c) => {
  const token = bearer(c.req.header("authorization"));
  if (!token) return c.json({ error: "missing bearer session — sign in to Talk first" }, 401);
  const db = makeDb(c.env.DB);
  const address = await resolveSession(db, token);
  if (!address) return c.json({ error: "invalid or expired session" }, 401);
  const parsed = submitDocSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid dating doc", issues: parsed.error.issues }, 400);
  const r = await submitDatingDoc(db, c.env, { address, ...parsed.data });
  return c.json(r.body, r.code as 200 | 400 | 402 | 403 | 413 | 422);
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
