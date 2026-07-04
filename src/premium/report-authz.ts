/**
 * Authorization for the grounded compatibility report (IDOR fix, 2026-07-04).
 *
 * The grounded report DECRYPTS both personas' private hearts (`personas.heart_json`) and reads their
 * courtship, so it must never run for someone who is not a member of the named couple. Before this
 * guard existed, `POST /api/premium/compatibility-report` took `coupleId` straight from the request
 * body and decrypted any couple's two dating docs for whoever paid the flat fee — a cross-couple PII
 * read. These helpers resolve the caller's PROVEN identity (the settled x402 payer wallet, or a
 * founder-comped owner id) to an owner and require that owner to own one of the couple's two personas.
 *
 * Fail closed everywhere: an unresolvable wallet, a null owner, or a persona with no owner NEVER
 * satisfies membership — the route must skip decryption when `isCoupleMember` is false.
 */
import type { Env } from "../env";

/**
 * Resolve an EVM wallet address to the owner id that controls it. Canonical source is the
 * `owner_wallets` ledger (an active EVM row); falls back to the `owners.wallet` convenience column.
 * Case-insensitive (addresses are stored as received, sometimes checksummed). Returns null when the
 * wallet maps to no owner — callers MUST treat null as "cannot authorize" and fail closed.
 */
export async function ownerIdForWallet(env: Env, wallet: string | null | undefined): Promise<number | null> {
  const w = (wallet ?? "").trim().toLowerCase();
  if (!w) return null;
  const ow = await env.DB.prepare(
    "SELECT owner_id AS ownerId FROM owner_wallets WHERE lower(address)=?1 AND chain_family='evm' AND status='active' ORDER BY id DESC LIMIT 1",
  )
    .bind(w)
    .first<{ ownerId: number | null }>();
  if (ow?.ownerId != null) return ow.ownerId;
  const o = await env.DB.prepare("SELECT id FROM owners WHERE wallet IS NOT NULL AND lower(wallet)=?1 LIMIT 1")
    .bind(w)
    .first<{ id: number }>();
  return o?.id ?? null;
}

export interface CoupleMembership {
  /** The couple's two persona ids, or null when the couple does not exist. */
  couple: { aId: number; bId: number } | null;
  /** Owner id behind persona A (null if the persona is ownerless). */
  ownerA: number | null;
  /** Owner id behind persona B (null if the persona is ownerless). */
  ownerB: number | null;
}

/** Load a couple and the owner ids of its two personas. `couple` is null for an unknown couple id. */
export async function loadCoupleMembership(env: Env, coupleId: number): Promise<CoupleMembership> {
  const cr = await env.DB.prepare("SELECT a_id AS aId, b_id AS bId FROM couples WHERE id=?1")
    .bind(coupleId)
    .first<{ aId: number; bId: number }>();
  if (!cr) return { couple: null, ownerA: null, ownerB: null };
  const ownerOf = async (personaId: number): Promise<number | null> =>
    (await env.DB.prepare("SELECT owner_id AS o FROM personas WHERE id=?1").bind(personaId).first<{ o: number | null }>())?.o ?? null;
  return { couple: { aId: cr.aId, bId: cr.bId }, ownerA: await ownerOf(cr.aId), ownerB: await ownerOf(cr.bId) };
}

/**
 * Is `callerOwnerId` a member of the couple — i.e., does it own persona A or B? A null caller, a
 * missing couple, or a null persona-owner never matches (fail closed).
 */
export function isCoupleMember(m: CoupleMembership, callerOwnerId: number | null): boolean {
  if (callerOwnerId == null || m.couple == null) return false;
  return callerOwnerId === m.ownerA || callerOwnerId === m.ownerB;
}
