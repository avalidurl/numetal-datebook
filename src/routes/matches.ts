/**
 * Magic-link "YOUR MATCHES" — a PUBLIC-SAFE, per-owner read reached from a signed link in the human's
 * match email. The token (crypto/matchtoken) binds the page to ONE ownerId; there is no account and no
 * founder key. Mounted ABOVE the access gate (like /api/featured): a human can't hold the ACCESS_KEY.
 *
 * PRE-REVEAL SAFETY (the crown jewel): for each of the owner's couples we serve ONLY the OTHER side's
 * chaperoned, PII-free public summary + the courtship status. The other person's contact (owners.
 * contactRef) is decrypted and included ONLY when `revealUnlocked` — i.e. `revealReady(coupleId)` is
 * true: BOTH owners identity_verified, BOTH recorded 18+, BOTH consented to contact_reveal. Before that
 * gate, `contact` is hard-null. This is the SAME gate the bilateral /api/escalations/reveal endpoint
 * enforces (imported, not re-implemented) — one source of truth for "is contact allowed to leave".
 *
 * The token binds to one owner, so there is NO enumeration surface: a holder sees their own couples
 * only, never another owner's, never an owner id they didn't already implicitly hold.
 */
import { Hono } from "hono";
import { and, eq, inArray, or } from "drizzle-orm";
import { db as makeDb, type DB } from "../db/client";
import { couples, heartFiles, owners, personas } from "../db/schema";
import { open } from "../crypto/box";
import { revealReady } from "./identity";
import { verifyMatchToken } from "../crypto/matchtoken";
import type { Env } from "../env";

export const matchesRoutes = new Hono<{ Bindings: Env }>();

/** Map a raw couple `state` to a public, human-readable status label. */
function statusLabel(state: string): string {
  switch (state) {
    case "met":
      return "matched";
    case "courting":
      return "courting";
    case "committed":
      return "committed";
    case "dormant":
      return "paused";
    case "ended":
      return "ended";
    default:
      return state;
  }
}

export interface MatchCard {
  coupleId: number;
  // The OTHER side's PUBLIC, PII-free summary — handle + chaperoned public blurb only. Never the
  // other owner's contactRef, display name's PII, heart body, or any private field.
  otherPublicSummary: { handle: string | null; summary: string | null };
  status: string; // public status label (matched|courting|committed|paused|ended)
  state: string; // raw couple state (for the client to branch on if it wants)
  revealUnlocked: boolean; // true ONLY when revealReady (both verified+18+ & both consented)
  // PRESENT ONLY when revealUnlocked, else null. Decrypted other-owner contactRef. Never set pre-gate.
  contact: string | null;
}

/**
 * List a single owner's matches. PRE-REVEAL SAFE by construction: contact is fetched/decrypted ONLY
 * inside the `revealUnlocked` branch, so a couple that hasn't cleared every reveal gate can never emit
 * a contact. Returns the OTHER persona's public summary for each couple the owner is part of.
 */
export async function listMatchesForOwner(db: DB, env: Env, ownerId: number): Promise<MatchCard[]> {
  // The owner's persona ids (an owner may run more than one persona/heart).
  const myPersonas = await db.select({ id: personas.id }).from(personas).where(eq(personas.ownerId, ownerId)).all();
  const myPersonaIds = myPersonas.map((p) => p.id);
  if (myPersonaIds.length === 0) return [];

  // Every couple where ONE side is one of the owner's personas. couples reference personas (a_id,b_id).
  const myCouples = await db
    .select({ id: couples.id, aId: couples.aId, bId: couples.bId, state: couples.state })
    .from(couples)
    .where(or(inArray(couples.aId, myPersonaIds), inArray(couples.bId, myPersonaIds)))
    .all();
  if (myCouples.length === 0) return [];

  const cards: MatchCard[] = [];
  for (const cpl of myCouples) {
    // The OTHER persona id is whichever side is NOT ours.
    const mine = new Set(myPersonaIds);
    const otherPersonaId = mine.has(cpl.aId) ? cpl.bId : cpl.aId;

    // Other side's PUBLIC summary: persona handle + the chaperoned heart-file public summary (if any).
    // NEVER the heart body (private), the other owner's contactRef, or display name.
    const otherPersona = await db
      .select({ handle: personas.handle, ownerId: personas.ownerId })
      .from(personas)
      .where(eq(personas.id, otherPersonaId))
      .get();
    let summary: string | null = null;
    if (otherPersona) {
      const hf = await db
        .select({ publicSummary: heartFiles.publicSummary })
        .from(heartFiles)
        .where(and(eq(heartFiles.personaId, otherPersonaId), eq(heartFiles.status, "admitted")))
        .get();
      summary = hf?.publicSummary ?? null;
    }

    const revealUnlocked = await revealReady(db, cpl.id);
    let contact: string | null = null;
    // CONTACT IS GATED: only the unlocked branch ever touches owners.contactRef. A locked couple
    // returns contact:null without the column even being read.
    if (revealUnlocked && otherPersona?.ownerId != null) {
      const otherOwner = await db
        .select({ contactRef: owners.contactRef })
        .from(owners)
        .where(eq(owners.id, otherPersona.ownerId))
        .get();
      contact = (await open(env, otherOwner?.contactRef ?? null)) ?? null;
    }

    cards.push({
      coupleId: cpl.id,
      otherPublicSummary: { handle: otherPersona?.handle ?? null, summary },
      status: statusLabel(cpl.state),
      state: cpl.state,
      revealUnlocked,
      contact,
    });
  }
  return cards;
}

/**
 * GET /api/matches?token=… — PUBLIC (above the access gate), rate-limited as a public read. Verifies
 * the per-owner magic-link token → ownerId, then serves ONLY that owner's matches. A bad/expired/forged
 * token → 401 (with an `expired` flag so the page can tell the human to request a fresh link). The
 * token binds to one owner, so there is no IDOR/enumeration surface — there is no owner id in the URL.
 */
matchesRoutes.get("/matches", async (c) => {
  const token = c.req.query("token");
  const v = await verifyMatchToken(c.env, token);
  if (!v.ok) {
    // Never leak which secret/branch detail failed; tell the client only enough to act:
    //   - unconfigured → the venue can't verify links yet (503, not a client error)
    //   - expired      → ask for a fresh link
    //   - anything else (malformed/bad_signature) → a flat invalid-link 401
    if (v.reason === "unconfigured") return c.json({ ok: false, error: "matches links are not enabled on this venue yet" }, 503);
    const expired = v.reason === "expired";
    return c.json({ ok: false, error: expired ? "this link has expired" : "invalid link", expired }, 401);
  }
  const db = makeDb(c.env.DB);
  const matches = await listMatchesForOwner(db, c.env, v.ownerId);
  return c.json({ ok: true, matches });
});
