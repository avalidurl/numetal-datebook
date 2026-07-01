/**
 * Agent self-service (Phase 2) — an already-verified agent proves control of its registered key
 * (EIP-191 over a FRESH single-use challenge) to (a) change its human's notify channels + delivery
 * webhook, or (b) mint a short-TTL match-token so it can POLL GET /api/matches?token. Runtime-agnostic:
 * any agent holding the keypair it registered (OpenClaw / Hermes / Claude / Codex / custom) can call these.
 *
 * AUTH (why signature, not the match token): changing the delivery webhook is sensitive — a leaked match
 * token must NOT be able to redirect an owner's alerts. So both mutations require a signature from the
 * endpoint's registered publicKey over a fresh server-issued nonce (single-use, rotated on every attempt).
 * This reuses the exact EIP-191 path that activates an endpoint (src/identity/endpoints.ts). All routes
 * mount ABOVE the access gate (agents are public; they authenticate by key, not the founder ACCESS_KEY).
 */
import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { verifyMessage } from "viem";
import type { DB } from "../db/client";
import { db as makeDb } from "../db/client";
import { agentEndpoints, owners } from "../db/schema";
import type { Env } from "../env";
import { seal } from "../crypto/box";
import { isSafeDeliveryUrl } from "../agentrelay/outbound";
import { mintMatchToken } from "../crypto/matchtoken";

export const agentRoutes = new Hono<{ Bindings: Env }>();

const MATCH_TOKEN_PULL_TTL = 60 * 60; // 1h — short-lived so a leaked pull token self-expires fast

const idSchema = z.object({ endpointId: z.number().int().positive() });
const sigSchema = z.object({ endpointId: z.number().int().positive(), signature: z.string().startsWith("0x") });
const deliverySchema = z.object({
  endpointId: z.number().int().positive(),
  signature: z.string().startsWith("0x"),
  channels: z.array(z.enum(["email", "agent-relay", "xmtp"])).max(5).optional(),
  delivery: z.object({ url: z.string().url().max(400), secret: z.string().min(16).max(200) }).optional(),
});

const freshChallenge = (): string => `ishtar-agent:${crypto.randomUUID()}:${Date.now()}`;

/** An endpoint that CAN prove control by signature: active + has a publicKey + is owner-scoped. */
async function loadSignable(db: DB, endpointId: number) {
  const ep = await db.select().from(agentEndpoints).where(eq(agentEndpoints.id, endpointId)).get();
  if (!ep || ep.status !== "active" || !ep.publicKey || !ep.ownerId) return null;
  return ep;
}

/** Verify the signature over the endpoint's current challenge, then ROTATE it (single-use, replay-safe). */
async function proveAndConsume(
  db: DB,
  ep: { id: number; publicKey: string | null; challengeNonce: string | null },
  signature: string,
): Promise<boolean> {
  let ok = false;
  if (ep.publicKey && ep.challengeNonce) {
    try {
      ok = await verifyMessage({
        address: ep.publicKey as `0x${string}`,
        message: ep.challengeNonce,
        signature: signature as `0x${string}`,
      });
    } catch {
      ok = false;
    }
  }
  // Rotate the nonce regardless of outcome → the challenge is single-use; a replay finds a new nonce.
  await db
    .update(agentEndpoints)
    .set({ challengeNonce: freshChallenge(), updatedAt: new Date().toISOString() })
    .where(eq(agentEndpoints.id, ep.id))
    .run()
    .catch(() => {});
  return ok;
}

/** POST /api/agent/challenge — issue a fresh single-use challenge for a signature-capable endpoint. */
agentRoutes.post("/agent/challenge", async (c) => {
  const parsed = idSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "endpointId required" }, 400);
  const db = makeDb(c.env.DB);
  const ep = await loadSignable(db, parsed.data.endpointId);
  if (!ep) return c.json({ error: "no active signature-capable endpoint" }, 404);
  const challenge = freshChallenge();
  await db
    .update(agentEndpoints)
    .set({ challengeNonce: challenge, updatedAt: new Date().toISOString() })
    .where(eq(agentEndpoints.id, ep.id))
    .run();
  return c.json({ challenge, sign: "EIP-191 personal_sign over `challenge` with your registered publicKey" });
});

/** POST /api/agent/delivery — change the owner's notify channels and/or delivery webhook (sig-gated). */
agentRoutes.post("/agent/delivery", async (c) => {
  const parsed = deliverySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);
  const b = parsed.data;
  if (b.delivery && !isSafeDeliveryUrl(b.delivery.url)) {
    return c.json({ error: "delivery.url must be a public https URL" }, 400);
  }
  if (!b.channels && !b.delivery) return c.json({ error: "nothing to change" }, 400);
  const db = makeDb(c.env.DB);
  const ep = await loadSignable(db, b.endpointId);
  if (!ep) return c.json({ error: "no active signature-capable endpoint" }, 404);
  if (!(await proveAndConsume(db, ep, b.signature))) {
    return c.json({ error: "signature did not verify (request a fresh /api/agent/challenge)" }, 401);
  }

  const ownerId = ep.ownerId as number;
  const changed: string[] = [];
  if (b.channels?.length) {
    const csv = Array.from(new Set(b.channels.map((s) => s.toLowerCase()))).join(",");
    await db.update(owners).set({ alertChannels: csv }).where(eq(owners.id, ownerId)).run();
    changed.push("channels");
  }
  if (b.delivery) {
    const url = (await seal(c.env, b.delivery.url)) ?? b.delivery.url;
    const secret = (await seal(c.env, b.delivery.secret)) ?? b.delivery.secret;
    await c.env.DB.prepare(
      "INSERT INTO owner_deliveries (owner_id, url, secret, status) VALUES (?1, ?2, ?3, 'active') ON CONFLICT(owner_id) DO UPDATE SET url=?2, secret=?3, status='active', updated_at=datetime('now')",
    )
      .bind(ownerId, url, secret)
      .run();
    changed.push("delivery");
  }
  return c.json({ ok: true, ownerId, changed });
});

/** POST /api/agent/match-token — mint a SHORT-TTL match token so the agent can poll GET /api/matches. */
agentRoutes.post("/agent/match-token", async (c) => {
  const parsed = sigSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "endpointId + signature required" }, 400);
  const db = makeDb(c.env.DB);
  const ep = await loadSignable(db, parsed.data.endpointId);
  if (!ep) return c.json({ error: "no active signature-capable endpoint" }, 404);
  if (!(await proveAndConsume(db, ep, parsed.data.signature))) {
    return c.json({ error: "signature did not verify (request a fresh /api/agent/challenge)" }, 401);
  }
  const token = await mintMatchToken(c.env, ep.ownerId as number, MATCH_TOKEN_PULL_TTL);
  if (!token) return c.json({ error: "match tokens are not enabled on this venue yet" }, 503);
  return c.json({ token, expiresInSeconds: MATCH_TOKEN_PULL_TTL, use: "GET /api/matches?token=<token>" });
});
