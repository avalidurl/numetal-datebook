/**
 * Constant-time string comparison for secrets (the operator ACCESS_KEY). A plain `===` short-circuits
 * on the first differing byte, leaking a length/prefix timing side-channel. We HMAC both inputs under a
 * fresh random key and compare the fixed-length digests byte-by-byte with no early-out — so neither the
 * value NOR the length of the secret is observable from response timing. WebCrypto is available in the
 * Workers runtime (and miniflare/vitest-pool-workers).
 */
export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const da = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(a)));
  const db = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i]! ^ db[i]!; // equal-length SHA-256 digests
  return diff === 0;
}
