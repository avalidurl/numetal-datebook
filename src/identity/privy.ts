/**
 * Privy access-token verification (human profile claim). Verifies the ES256 JWT locally
 * with the app's verification key — no network call. DISABLED (returns ok:false) until
 * PRIVY_APP_ID + PRIVY_VERIFICATION_KEY are set, so the tier ships dark and lights up
 * when the founder adds the Privy app. Any parse/verify failure → ok:false (fail-closed).
 */
import type { Env } from "../env";

export interface PrivyResult {
  ok: boolean;
  userId?: string;
  reason?: string;
}

const b64urlToBytes = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  return b64urlToBytes(body.replace(/\+/g, "-").replace(/\//g, "_")).buffer as ArrayBuffer;
}

export async function verifyPrivyToken(env: Env, token: string): Promise<PrivyResult> {
  if (!env.PRIVY_APP_ID || !env.PRIVY_VERIFICATION_KEY) {
    return { ok: false, reason: "privy not configured" };
  }
  try {
    const [h, p, sig] = token.split(".");
    if (!h || !p || !sig) return { ok: false, reason: "malformed token" };
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as {
      sub?: string;
      aud?: string;
      iss?: string;
      exp?: number;
    };
    if (payload.aud !== env.PRIVY_APP_ID) return { ok: false, reason: "aud mismatch" };
    if (payload.iss && !payload.iss.includes("privy")) return { ok: false, reason: "iss mismatch" };
    if (payload.exp && payload.exp * 1000 < Date.now()) return { ok: false, reason: "expired" };

    const key = await crypto.subtle.importKey(
      "spki",
      pemToDer(env.PRIVY_VERIFICATION_KEY),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      b64urlToBytes(sig),
      new TextEncoder().encode(`${h}.${p}`),
    );
    return valid ? { ok: true, userId: payload.sub } : { ok: false, reason: "bad signature" };
  } catch (e) {
    return { ok: false, reason: `privy_error: ${(e as Error).message}` };
  }
}
