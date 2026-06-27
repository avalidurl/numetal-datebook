/**
 * Public human onboarding (Phase 1). The first ungated WRITE that creates a real dater: an owner
 * (agent_represented) + a heart-file (with the optional structured `prefs` block) + a persona admitted
 * to the floor, then a warm confirmation email. Guarded by geo + the edge rate-limit (at the mount) +
 * a Turnstile bot check + the admission chaperone (unsafe / minor-coded docs are rejected). No human
 * login: the dating doc IS the profile; a human only surfaces (and claims/verifies) when a match holds.
 */
import { Hono } from "hono";
import { z } from "zod";
import { db as makeDb } from "../db/client";
import { heartFiles, owners } from "../db/schema";
import type { Env } from "../env";
import { admitWithCap } from "../admission";
import { hmacHex, seal } from "../crypto/box";
import { onboardConfirmHtml, resendAddContact, resendSend } from "../newsletter/resend";

export const onboardRoutes = new Hono<{ Bindings: Env }>();

const MAX_HEART_CHARS = 8000;

const onboardSchema = z.object({
  email: z.string().email().max(200),
  displayName: z.string().max(120).optional(),
  homeMarket: z.enum(["bay_area", "nyc", "other"]).default("other"),
  activeMarket: z.enum(["bay_area", "nyc", "remote"]).default("remote"),
  availableFor: z.string().max(120).optional(),
  ageAttested: z.literal(true), // must affirm 18+ to submit
  contactRef: z.string().max(200).optional(), // private reveal contact; defaults to the email
  heart: z.record(z.unknown()), // the dating doc; may carry the structured `prefs` block
  turnstileToken: z.string().optional(),
});

async function turnstileOk(env: Env, token: string | undefined, ip?: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true; // dark until configured
  if (!token) return false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
    });
    return !!((await r.json().catch(() => ({}))) as { success?: boolean }).success;
  } catch {
    return false;
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10);

onboardRoutes.post("/onboard", async (c) => {
  const parsed = onboardSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid submission", issues: parsed.error.issues }, 400);
  const b = parsed.data;
  const heartStr = JSON.stringify(b.heart);
  if (heartStr.length > MAX_HEART_CHARS) return c.json({ error: `dating doc too large (max ${MAX_HEART_CHARS} chars)` }, 413);
  const email = b.email.trim().toLowerCase();

  // Bot gate (dark until TURNSTILE_SECRET set; the mount also applies the intake rate-limit).
  if (!(await turnstileOk(c.env, b.turnstileToken, c.req.header("cf-connecting-ip") ?? undefined)))
    return c.json({ error: "bot check failed — please retry" }, 403);

  // Idempotency + anti-abuse gate. Claim the waitlist row FIRST, atomically (DO NOTHING RETURNING is
  // empty on a repeat). Only the first submit for an email goes on to create an owner/heart/persona and
  // send the confirmation — so a hostile client can't (a) email-cannon a victim's address with repeat
  // POSTs or (b) flood the floor with duplicate owners. The response is identical on the repeat path, so
  // whether an email is already registered can't be enumerated. Fail-open on a DB error (don't lose a
  // real dater); the per-IP rate-limit + Turnstile still bound volume.
  const emailHash = await hmacHex(c.env, email);
  const sealedEmail = (await seal(c.env, email)) ?? email;
  let claimed = true;
  try {
    const ins = await c.env.DB.prepare(
      "INSERT INTO waitlist (email, email_hash, handle, kind, source) VALUES (?1,?2,?3,'human','onboard') ON CONFLICT(email_hash) DO NOTHING RETURNING email_hash",
    )
      .bind(sealedEmail, emailHash, b.displayName ?? null)
      .first();
    claimed = ins != null;
  } catch {
    /* fail-open: a transient waitlist error must not block onboarding */
  }
  if (!claimed) return c.json({ ok: true, onFloor: true });

  const db = makeDb(c.env.DB);
  // Owner (agent_represented) + sealed reveal contact. Heart body sealed at rest.
  const owner = await db
    .insert(owners)
    .values({
      displayName: b.displayName,
      contactRef: await seal(c.env, b.contactRef?.trim() || email),
      homeMarket: b.homeMarket,
      activeMarket: b.activeMarket,
      availableFor: b.availableFor,
      researchOptin: "none",
      publicChatter: 0,
      ageAttested: 1,
      tier: "agent_represented",
    })
    .returning({ id: owners.id })
    .get();
  await db
    .insert(heartFiles)
    .values({ ownerId: owner.id, revision: 1, bodyJson: (await seal(c.env, heartStr)) ?? "", availableFor: b.availableFor, status: "submitted" })
    .run();

  // Admit a persona so the dater enters the floor (chaperone + adult gate + atomic cap apply).
  const handle = (slug(b.displayName || "dater") || "dater") + Math.random().toString(36).slice(2, 8);
  const admit = await admitWithCap(db, c.env, {
    handle,
    model: c.env.CHAT_MODEL || c.env.GAMBIT_MODEL,
    personaAge: "18+",
    heartText: heartStr,
    ownerId: owner.id,
    homeMarket: b.homeMarket,
    activeMarket: b.activeMarket,
  });

  // The warm confirmation + cohort list add — best-effort, fail-soft, sent ONCE (first submit only).
  c.executionCtx.waitUntil(
    resendSend(c.env, { to: email, subject: "Your dating doc is on the floor — Ishtar", html: onboardConfirmHtml(b.displayName) }).then(() => {}),
  );
  c.executionCtx.waitUntil(resendAddContact(c.env, email).then(() => {}));

  return c.json({ ok: true, ownerId: owner.id, onFloor: admit.admitted, ...(admit.admitted ? {} : { held: admit.reason }) });
});
