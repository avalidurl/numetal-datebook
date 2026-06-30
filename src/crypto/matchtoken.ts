/**
 * Magic-link MATCH TOKEN — a stateless, per-owner, expiring bearer that lets a human open their
 * "YOUR MATCHES" page from a link in their match email, with NO account and NO founder key. It binds
 * the page to exactly ONE ownerId, so a holder can never enumerate another human's matches.
 *
 * AUTHORITATIVE WIRE FORMAT — the NOTIFY branch MINTS this token (src/notify/dispatch.ts), this
 * branch only VERIFIES it. The two MUST be byte-compatible. This module implements the notify
 * scheme exactly so the branch stands alone; at merge we can collapse to importing notify's
 * exported verifyMatchToken.
 *
 *   token  = "v1." + body64 + "." + sig64
 *   body64 = base64url(utf8(JSON.stringify({ o: <ownerId>, exp: <unixSeconds> })))   // KEY ORDER {o, exp}
 *   sig64  = base64url(HMAC_SHA256(key, "v1." + body64))                              // SIGNED INPUT INCLUDES "v1."
 *   key    = utf8(env.NOTIFY_TOKEN_SECRET || env.ENCRYPTION_KEY)                      // verbatim UTF-8, NOT base64-decoded
 *   base64url = standard base64 with '+'→'-', '/'→'_', '=' padding STRIPPED
 *
 * Load-bearing details (mismatch = every link 401s):
 *   - The JSON object is `{ o, exp }` (NOT `{ ownerId, exp }`); ownerId is read from `o`.
 *   - The HMAC covers the STRING "v1." + body64 (the version prefix is part of the signed input).
 *   - The signing key is the secret VERBATIM as UTF-8 bytes (same pepper convention as box.hmacHex),
 *     preferring NOTIFY_TOKEN_SECRET, falling back to ENCRYPTION_KEY (which exists as a Worker secret).
 *
 * SECURITY:
 *   - Verification recomputes the HMAC over "v1."+body64 and compares CONSTANT-TIME (no early-exit
 *     byte compare → no timing oracle on the signature).
 *   - A tampered body (any byte flipped) changes body64 → a different expected MAC → reject. A
 *     tampered/forged sig fails the constant-time compare → reject. A wrong version prefix, missing
 *     part, or garbage encoding fails structural parsing → reject.
 *   - `exp` is enforced server-side; an expired token is rejected even with a valid signature.
 *   - When neither key is set the venue can neither mint nor verify (returns null / unconfigured) —
 *     fail-closed, never a static/guessable key. (box.ts falls back to an unkeyed hash for at-rest
 *     dedup; a BEARER token must NOT, so this module has no dark fallback.)
 */
import type { Env } from "../env";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const VERSION = "v1";

/** Default mint TTL: 7 days (matches the notify branch). A leaked link self-expires after a week. */
export const MATCH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface MatchTokenPayload {
  o: number; // ownerId
  exp: number; // unix seconds
}

/* ── base64url (unpadded, URL-safe) ─────────────────────────────────────────────────────────── */
function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlEncodeStr(str: string): string {
  return b64urlEncode(encoder.encode(str));
}
function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The signing key: NOTIFY_TOKEN_SECRET, else ENCRYPTION_KEY — VERBATIM UTF-8 (not base64-decoded). */
function rawKey(env: Env): string | null {
  const k = env.NOTIFY_TOKEN_SECRET || env.ENCRYPTION_KEY;
  return k && k.trim() ? k.trim() : null;
}

async function hmacKey(env: Env): Promise<CryptoKey | null> {
  const raw = rawKey(env);
  if (!raw) return null; // fail-closed: no signing key → no tokens
  return crypto.subtle.importKey("raw", encoder.encode(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** Constant-time equality on two byte arrays (length-independent: a length mismatch is folded into
 *  the accumulator so the compare itself never short-circuits and can't leak length via timing). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Mint a per-owner match token in the authoritative `v1.` scheme (byte-compatible with the notify
 * minter). `ttlSeconds` defaults to MATCH_TOKEN_TTL_SECONDS. Returns null when no signing key is set.
 * Stateless — no DB row; the signature IS the proof. (This branch verifies; mint is provided so the
 * helper is self-contained + round-trip testable.)
 */
export async function mintMatchToken(
  env: Env,
  ownerId: number,
  ttlSeconds: number = MATCH_TOKEN_TTL_SECONDS,
): Promise<string | null> {
  const key = await hmacKey(env);
  if (!key) return null;
  const exp = Math.floor(Date.now() / 1000) + Math.max(1, Math.trunc(ttlSeconds));
  // Key order EXACTLY {o, exp} to match the minter's JSON.stringify byte output.
  const body64 = b64urlEncodeStr(JSON.stringify({ o: Math.trunc(ownerId), exp }));
  const signedInput = `${VERSION}.${body64}`; // the SIGNED INPUT includes the "v1." prefix
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(signedInput)));
  return `${signedInput}.${b64urlEncode(sig)}`;
}

export type MatchTokenResult =
  | { ok: true; ownerId: number; exp: number }
  | { ok: false; reason: "unconfigured" | "malformed" | "bad_signature" | "expired" };

/**
 * Verify a `v1.` match token → its ownerId (read from the body's `o` field). Rejects (never throws)
 * on: no signing key, malformed structure / wrong version, a signature that fails the constant-time
 * compare (forged/tampered), or an expired `exp`. The caller maps every `ok:false` to a 401.
 */
export async function verifyMatchToken(env: Env, token: string | undefined | null): Promise<MatchTokenResult> {
  const key = await hmacKey(env);
  if (!key) return { ok: false, reason: "unconfigured" };
  if (!token || typeof token !== "string") return { ok: false, reason: "malformed" };

  // Exactly three dot-separated parts: "v1", body64, sig64.
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [version, body64, sig64] = parts as [string, string, string];
  if (version !== VERSION || !body64 || !sig64) return { ok: false, reason: "malformed" };

  let providedSig: Uint8Array;
  try {
    providedSig = b64urlDecode(sig64);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // Recompute the MAC over the EXACT signed input ("v1." + body64) and compare CONSTANT-TIME. A
  // tampered body changes body64 → a different expected MAC → mismatch; a forged sig → mismatch.
  const signedInput = `${version}.${body64}`;
  const expectedSig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(signedInput)));
  if (!timingSafeEqual(providedSig, expectedSig)) return { ok: false, reason: "bad_signature" };

  // Signature verified → the body is authentic; only now parse + check expiry. ownerId comes from `o`.
  let payload: MatchTokenPayload;
  try {
    payload = JSON.parse(decoder.decode(b64urlDecode(body64)));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload || !Number.isInteger(payload.o) || payload.o <= 0 || !Number.isFinite(payload.exp)) {
    return { ok: false, reason: "malformed" };
  }
  if (Math.floor(Date.now() / 1000) >= payload.exp) return { ok: false, reason: "expired" };
  return { ok: true, ownerId: payload.o, exp: payload.exp };
}
