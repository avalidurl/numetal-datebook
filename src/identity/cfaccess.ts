/**
 * Cloudflare Access JWT verification. When the operator surface sits behind Cloudflare
 * Access (email one-time-PIN), Cloudflare injects a signed JWT as the
 * `Cf-Access-Jwt-Assertion` header (and the CF_Authorization cookie). Verifying it
 * (RS256 vs the team JWKS + aud + iss + exp) lets the Worker trust the EMAIL login —
 * so there is never a key in a URL. No-op (ok:false) unless ACCESS_TEAM_DOMAIN +
 * ACCESS_AUD are set. Fail-closed on any error.
 */
import type { Env } from "../env";

const b64urlToBytes = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

// Per-isolate JWKS cache (1h). Access rotates keys rarely; a stale miss just re-fetches.
let jwks: { domain: string; at: number; keys: Record<string, CryptoKey> } | null = null;

async function teamKeys(domain: string): Promise<Record<string, CryptoKey>> {
  if (jwks && jwks.domain === domain && Date.now() - jwks.at < 3_600_000) return jwks.keys;
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  const body = (await res.json()) as { keys?: Array<JsonWebKey & { kid: string }> };
  const keys: Record<string, CryptoKey> = {};
  for (const jwk of body.keys ?? []) {
    keys[jwk.kid] = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  }
  jwks = { domain, at: Date.now(), keys };
  return keys;
}

export interface AccessResult {
  ok: boolean;
  email?: string;
  reason?: string;
}

export async function verifyAccessJwt(env: Env, token: string | undefined): Promise<AccessResult> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return { ok: false, reason: "access not configured" };
  if (!token) return { ok: false, reason: "no assertion" };
  try {
    const [h, p, sig] = token.split(".");
    if (!h || !p || !sig) return { ok: false, reason: "malformed" };
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as { kid?: string };
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as {
      aud?: string | string[];
      iss?: string;
      exp?: number;
      email?: string;
    };
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(env.ACCESS_AUD)) return { ok: false, reason: "aud mismatch" };
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return { ok: false, reason: "iss mismatch" };
    if (payload.exp && payload.exp * 1000 < Date.now()) return { ok: false, reason: "expired" };
    const key = header.kid ? (await teamKeys(env.ACCESS_TEAM_DOMAIN))[header.kid] : undefined;
    if (!key) return { ok: false, reason: "unknown kid" };
    const valid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      b64urlToBytes(sig),
      new TextEncoder().encode(`${h}.${p}`),
    );
    return valid ? { ok: true, email: payload.email } : { ok: false, reason: "bad signature" };
  } catch (e) {
    return { ok: false, reason: `access_error: ${(e as Error).message}` };
  }
}
