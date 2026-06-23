/**
 * Persona Relay age-assurance adapter (the Phase-1 18+ gate; replaces Didit).
 *
 * Privacy-preserving by design: verification happens inside Persona's widget and the result is
 * relayed to us as a cryptographic Privacy Pass claim (blind RSA). We only ever receive a
 * passed/failed boolean — never the user's ID — and the claim is unlinkable. The SDK's crypto is
 * @cloudflare/blindrsa-ts (WebCrypto), so it runs natively in this Worker (no Gateway service).
 *
 * Flow:
 *   createAgeSession()  → relays.create + issuePrivacyPass → store {relayToken, relaySecret,
 *                          privacyPassToken} server-side, return relaySessionAccessToken to the widget.
 *   (widget runs; onComplete fires)
 *   redeemAgeClaim()    → relays.generateClaim → parse claimPayload → 'passed' | 'failed'.
 *
 * encryptionKeyPem is null for now → claimPayload is plain JSON. It carries only a pass/fail
 * boolean (no PII), travels over HTTPS, and the Privacy Pass is the integrity unit; payload
 * encryption (WebCrypto RSA-OAEP) is a documented later hardening step.
 */
import { Persona } from "@persona/sdk-node";
import type { Env } from "../env";

function client(env: Env) {
  return new Persona({ apiKey: env.PERSONA_API_KEY });
}

export async function createAgeSession(
  env: Env,
  ownerId: number,
): Promise<{ ok: true; accessToken: string } | { ok: false; reason: string }> {
  if (!env.PERSONA_API_KEY || !env.PERSONA_CLAIM_TYPE) return { ok: false, reason: "persona not configured" };
  try {
    const persona = client(env);
    const claimType = env.PERSONA_CLAIM_TYPE;
    const { relayToken, relaySecret, relaySessionAccessToken } = await persona.relays.create({
      claimType,
      encryptionKeyPem: null,
    });
    const { privacyPassToken } = await persona.relays.issuePrivacyPass({ claimType });
    await env.DB.prepare(
      "INSERT INTO relay_sessions (owner_id, relay_token, relay_secret, privacy_pass_token, claim_type, status) VALUES (?1,?2,?3,?4,?5,'created') " +
        "ON CONFLICT(owner_id) DO UPDATE SET relay_token=?2, relay_secret=?3, privacy_pass_token=?4, claim_type=?5, status='created', created_at=datetime('now')",
    )
      .bind(ownerId, relayToken, relaySecret, privacyPassToken, claimType)
      .run();
    return { ok: true, accessToken: relaySessionAccessToken };
  } catch (e) {
    return { ok: false, reason: `persona_create: ${(e as Error).message}`.slice(0, 300) };
  }
}

export async function redeemAgeClaim(
  env: Env,
  ownerId: number,
): Promise<{ ok: true; result: "passed" | "failed" } | { ok: false; reason: string }> {
  try {
    const row = await env.DB.prepare(
      "SELECT relay_token, relay_secret, privacy_pass_token FROM relay_sessions WHERE owner_id=?1",
    )
      .bind(ownerId)
      .first<{ relay_token: string; relay_secret: string; privacy_pass_token: string }>();
    if (!row) return { ok: false, reason: "no age session" };
    const persona = client(env);
    const { claimPayload } = await persona.relays.generateClaim({
      relayToken: row.relay_token,
      relaySecret: row.relay_secret,
      privacyPassToken: row.privacy_pass_token,
    });
    const claim = JSON.parse(claimPayload) as { claim_result?: string };
    const result: "passed" | "failed" = claim.claim_result === "passed" ? "passed" : "failed";
    await env.DB.prepare("UPDATE relay_sessions SET status=?2 WHERE owner_id=?1").bind(ownerId, result).run();
    return { ok: true, result };
  } catch (e) {
    return { ok: false, reason: `persona_redeem: ${(e as Error).message}`.slice(0, 300) };
  }
}
