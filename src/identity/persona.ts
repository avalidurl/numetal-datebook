/**
 * Persona Relay age-assurance adapter (the Phase-1 18+ gate; replaces Didit).
 *
 * Privacy-preserving by design: verification happens inside Persona's widget and the result is
 * relayed to us as a cryptographic Privacy Pass claim (blind RSA). We only ever receive a
 * passed/failed boolean — never the user's ID — and the claim is unlinkable. The SDK's crypto is
 * @cloudflare/blindrsa-ts (WebCrypto), so it runs natively in this Worker.
 *
 * Hardened (red-team 2026-06-23): the relay_secret + privacy_pass_token are sealed at rest (a DB
 * read can no longer call generateClaim or forge a pass — C2); the session is bound to the invite +
 * the claiming Privy user + a 15-min expiry (H7); redemption is idempotent and does the full effect
 * (status + identity_verifications + tier) in one place so a replay can't double-spend (M2). Error
 * reasons are token-sanitized before they leave this module (L1).
 */
import type { Env } from "../env";
import { open, seal } from "../crypto/box";

const SESSION_TTL_MS = 15 * 60 * 1000;

// Lazy-load the Persona SDK so it stays OUT of the static import graph: the deployed worker bundle
// inlines this dynamic import (verified live), while the vitest-pool-workers test runtime — which
// can't CJS-require the SDK's ESM dep — never evaluates it unless a test exercises the age flow.
async function client(env: Env) {
  const { Persona } = await import("@persona/sdk-node");
  return new Persona({ apiKey: env.PERSONA_API_KEY });
}

// Never let a provider exception (which may carry a token/secret) reach the error ledger / Slack.
function sanitize(msg: string): string {
  return msg.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]").slice(0, 200);
}

export async function createAgeSession(
  env: Env,
  ownerId: number,
  inviteId: number,
  claimedBy: string,
): Promise<{ ok: true; accessToken: string } | { ok: false; reason: string }> {
  if (!env.PERSONA_API_KEY || !env.PERSONA_CLAIM_TYPE) return { ok: false, reason: "persona not configured" };
  // Don't clobber a LIVE in-flight session that belongs to a different login (race / hijack guard).
  const existing = await env.DB.prepare("SELECT status, claimed_by, expires_at FROM relay_sessions WHERE owner_id=?1")
    .bind(ownerId)
    .first<{ status: string; claimed_by: string | null; expires_at: string | null }>();
  if (
    existing &&
    existing.status === "created" &&
    existing.claimed_by &&
    existing.claimed_by !== claimedBy &&
    existing.expires_at &&
    new Date(existing.expires_at).getTime() > Date.now()
  ) {
    return { ok: false, reason: "a verification is already in progress for this profile" };
  }
  try {
    const persona = await client(env);
    const claimType = env.PERSONA_CLAIM_TYPE;
    const { relayToken, relaySecret, relaySessionAccessToken } = await persona.relays.create({
      claimType,
      encryptionKeyPem: null,
    });
    const { privacyPassToken } = await persona.relays.issuePrivacyPass({ claimType });
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await env.DB.prepare(
      "INSERT INTO relay_sessions (owner_id, relay_token, relay_secret, privacy_pass_token, claim_type, status, claimed_by, invite_id, expires_at) " +
        "VALUES (?1,?2,?3,?4,?5,'created',?6,?7,?8) " +
        "ON CONFLICT(owner_id) DO UPDATE SET relay_token=?2, relay_secret=?3, privacy_pass_token=?4, claim_type=?5, status='created', claimed_by=?6, invite_id=?7, expires_at=?8, created_at=datetime('now')",
    )
      .bind(ownerId, relayToken, await seal(env, relaySecret), await seal(env, privacyPassToken), claimType, claimedBy, inviteId, expiresAt)
      .run();
    return { ok: true, accessToken: relaySessionAccessToken };
  } catch (e) {
    return { ok: false, reason: sanitize(`persona_create: ${(e as Error).message}`) };
  }
}

/**
 * Redeem the completed Relay claim. Does the FULL effect atomically + idempotently: validates the
 * session belongs to this login and hasn't expired, fetches the claim, and on a pass promotes the
 * owner to identity_verified + records the 18+ result. A second call returns the stored verdict
 * without re-spending the Privacy Pass or re-inserting.
 */
export async function redeemAgeClaim(
  env: Env,
  ownerId: number,
  claimedBy: string,
): Promise<{ ok: true; result: "passed" | "failed" } | { ok: false; reason: string }> {
  try {
    const row = await env.DB.prepare(
      "SELECT relay_token, relay_secret, privacy_pass_token, status, claimed_by, expires_at FROM relay_sessions WHERE owner_id=?1",
    )
      .bind(ownerId)
      .first<{ relay_token: string; relay_secret: string; privacy_pass_token: string; status: string; claimed_by: string | null; expires_at: string | null }>();
    if (!row) return { ok: false, reason: "no age session" };
    if (row.status === "passed" || row.status === "failed") return { ok: true, result: row.status }; // idempotent
    if (row.claimed_by && row.claimed_by !== claimedBy) return { ok: false, reason: "session does not belong to this login" };
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: "age session expired" };

    const persona = await client(env);
    const relaySecret = (await open(env, row.relay_secret)) as string;
    const privacyPassToken = (await open(env, row.privacy_pass_token)) as string;
    const { claimPayload } = await persona.relays.generateClaim({ relayToken: row.relay_token, relaySecret, privacyPassToken });
    const claim = JSON.parse(claimPayload) as { claim_result?: string };
    const result: "passed" | "failed" = claim.claim_result === "passed" ? "passed" : "failed";

    await env.DB.prepare("UPDATE relay_sessions SET status=?2 WHERE owner_id=?1").bind(ownerId, result).run();
    await env.DB.prepare("INSERT INTO identity_verifications (owner_id, provider, status, age_over_18) VALUES (?1,'persona',?2,?3)")
      .bind(ownerId, result === "passed" ? "approved" : "declined", result === "passed" ? 1 : 0)
      .run();
    if (result === "passed") {
      await env.DB.prepare("UPDATE owners SET tier='identity_verified', updated_at=datetime('now') WHERE id=?1 AND tier='profile_claimed'")
        .bind(ownerId)
        .run();
    }
    return { ok: true, result };
  } catch (e) {
    return { ok: false, reason: sanitize(`persona_redeem: ${(e as Error).message}`) };
  }
}
