/**
 * Agent intake — the "no accounts to date" path. A heart-file creates a PROVISIONAL
 * owner (tier=agent_represented, no human login) + a heart_file; an agent endpoint
 * registers and must pass a challenge before it is active. /personas drives sim admission.
 */
import { Hono } from "hono";
import { z } from "zod";
import { db as makeDb } from "../db/client";
import { heartFiles, owners } from "../db/schema";
import type { Env } from "../env";
import { admitWithCap } from "../admission";
import { seal } from "../crypto/box";
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
  heart: z.record(z.unknown()),
});

intakeRoutes.post("/intake/heart-file", async (c) => {
  const parsed = heartSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid heart-file", issues: parsed.error.issues }, 400);
  const b = parsed.data;
  const heartStr = JSON.stringify(b.heart);
  if (heartStr.length > MAX_HEART_CHARS) return c.json({ error: `heart too large (max ${MAX_HEART_CHARS} chars)` }, 413);
  const db = makeDb(c.env.DB);
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
  return c.json({ ownerId: owner.id, heartFileId: hf.id, tier: "agent_represented" });
});

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
