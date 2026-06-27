/**
 * At-rest authenticated encryption (AES-256-GCM) for the handful of sensitive fields we
 * MUST keep but must not store in the clear: the private contactRef and the heart bodies.
 * These are reversible secrets (we have to reveal contactRef to broker an intro), so a
 * one-way hash won't do — we use AEAD with a key held only in a Worker secret.
 *
 * Dark until configured: with no ENCRYPTION_KEY, seal() is a no-op (returns plaintext) so
 * local/dev/tests run unchanged; open() returns legacy plaintext (no `enc:v1:` prefix)
 * as-is, so existing rows keep working and new rows encrypt the moment the secret is set.
 */
import type { Env } from "../env";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PREFIX = "enc:v1:";

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const ub64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyFor(env: Env): Promise<CryptoKey | null> {
  const raw = env.ENCRYPTION_KEY;
  if (!raw) return null;
  const bytes = ub64(raw.trim());
  if (bytes.length !== 32) throw new Error("ENCRYPTION_KEY must be base64 of 32 bytes (AES-256)");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Encrypt a string for at-rest storage. No-op (returns plaintext) until ENCRYPTION_KEY is set. */
export async function seal(env: Env, plaintext: string | null | undefined): Promise<string | null> {
  if (plaintext == null || plaintext === "") return plaintext ?? null;
  const key = await keyFor(env);
  if (!key) return plaintext; // dark until configured
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext)));
  return `${PREFIX}${b64(iv)}.${b64(ct)}`;
}

/**
 * Deterministic KEYED hash (HMAC-SHA256, hex) for opaque dedup keys that must not be offline-
 * precomputable from a DB-only leak (audit: an unsalted SHA-256(email) lets a leaker confirm which
 * emails are on a list via a rainbow table, even when the email itself is sealed). The pepper is the
 * Worker's ENCRYPTION_KEY. Falls back to unkeyed SHA-256 when the key is unset (dev/dark), so local
 * behaviour is unchanged.
 */
export async function hmacHex(env: Env, message: string): Promise<string> {
  const raw = env.ENCRYPTION_KEY;
  const data = encoder.encode(message);
  let digest: ArrayBuffer;
  if (raw) {
    const k = await crypto.subtle.importKey("raw", ub64(raw.trim()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    digest = await crypto.subtle.sign("HMAC", k, data);
  } else {
    digest = await crypto.subtle.digest("SHA-256", data); // dark/dev: unkeyed, unchanged behaviour
  }
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Decrypt an at-rest value. Legacy plaintext (no `enc:v1:` prefix) is returned unchanged. */
export async function open(env: Env, sealed: string | null | undefined): Promise<string | null> {
  if (sealed == null) return null;
  if (!sealed.startsWith(PREFIX)) return sealed; // legacy / unencrypted row
  const key = await keyFor(env);
  if (!key) throw new Error("ENCRYPTION_KEY required to read sealed data");
  const [ivb, ctb] = sealed.slice(PREFIX.length).split(".");
  if (!ivb || !ctb) throw new Error("malformed sealed value");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64(ivb) }, key, ub64(ctb));
  return decoder.decode(pt);
}
