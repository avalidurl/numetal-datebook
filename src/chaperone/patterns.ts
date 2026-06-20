/** Deterministic pre-pass patterns (T0). Cheap, run before the Llama-Guard classifier. */

// Minor-coded / non-consent framing denylist (admission + publish).
export const DENYLIST =
  /\b(teen|schoolgirl|schoolboy|high\s?school|minor|underage|barely\s?legal|age\s?play|preteen|jailbait)\b/i;

// PII / secret leak scan (publish paths): phone numbers, seed phrases, private keys, 32-byte hex.
export const PII_SCAN =
  /(\+?\d[\d\s().-]{7,}\d)|(seed\s?phrase)|(private\s?key)|(0x[a-fA-F0-9]{64})|(\b\d{3}-\d{2}-\d{4}\b)/i;

export const denylistHit = (text: string): boolean => DENYLIST.test(text);

/** Returns true if the body must be HELD (contains PII/secret). Wired into every publish path. */
export const leakHold = (text: string): boolean => PII_SCAN.test(text);
