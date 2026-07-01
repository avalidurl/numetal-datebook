// Coverage-guided (jazzer.js / libFuzzer) target for the LlamaPay webhook verifier — the HUMAN money
// boundary of The Window (a valid webhook auto-features a paid slot). verifyLlamapayWebhook is
// fail-closed: header sig = HMAC-SHA256(LLAMAPAY_WEBHOOK_SECRET, RAW_BODY).hex (lowercase), and the JSON
// is parsed ONLY after the signature passes.
//
// To exercise the PAYLOAD-PARSE PATH past the signature gate (the interesting, under-tested branch — a
// random signature would just bounce at the HMAC check), we compute a VALID signature over the fuzzed
// body with a fixed test secret, then verify. This forces every fuzzed body through JSON.parse + the
// event-shape validation inside the module.
//
// Oracle:
//   1. never throws (fail-soft on any parse/crypto error).
//   2. a validly-signed-but-GARBAGE body must return ok:false — NEVER ok:true with a malformed event.
//      If ok:true, the returned event MUST be a well-formed LlamapayEvent (string id, string type,
//      object data). ok:true on a malformed/partial event = a real finding (a forged/garbage payment
//      event slipping through to auto-feature a slot).
//
// HMAC replicated EXACTLY from src/payments/llamapay.ts: importKey("raw", enc(secret), HMAC/SHA-256) →
// sign(enc(rawBody)) → lowercase 2-digit hex. Uses Node's global crypto.subtle (Node 20+).
//
// A crash artifact = a real finding. If this throws or returns a bad ok:true, DO NOT weaken the oracle.
//
// Run: node_modules/.bin/jazzer fuzz/llamapay-webhook.fuzz fuzz/corpus/llamapay-webhook -- -max_total_time=25
import { verifyLlamapayWebhook } from "../src/payments/llamapay";

const TEST_SECRET = "whsec_jazzer_fixed_secret";

const enc = (s: string) => new TextEncoder().encode(s);
const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// Exactly the signature verifyLlamapayWebhook checks against: HMAC-SHA256(secret, rawBody) lowercase hex.
async function validSignature(rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc(TEST_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc(rawBody));
  return toHex(mac);
}

export async function fuzz(data: Buffer): Promise<void> {
  const body = data.toString("utf-8");
  const sig = await validSignature(body); // pass the signature gate → drive the payload-parse path
  const env = { LLAMAPAY_WEBHOOK_SECRET: TEST_SECRET } as unknown as Parameters<typeof verifyLlamapayWebhook>[0];

  const r = await verifyLlamapayWebhook(env, body, sig); // must never throw

  if (r.ok) {
    const ev = r.event as unknown;
    const wellFormed =
      !!ev &&
      typeof ev === "object" &&
      typeof (ev as { id?: unknown }).id === "string" &&
      typeof (ev as { type?: unknown }).type === "string" &&
      !!(ev as { data?: unknown }).data &&
      typeof (ev as { data?: unknown }).data === "object";
    if (!wellFormed) {
      throw new Error(`verifyLlamapayWebhook returned ok:true with a MALFORMED event for body: ${JSON.stringify(body)}`);
    }
  }
}
