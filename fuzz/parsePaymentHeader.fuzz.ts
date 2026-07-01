// Coverage-guided (jazzer.js / libFuzzer) target for the x402 payment-header decoder — the SOURCE OF
// TRUTH for amount / recipient / network / nonce that the resource server trusts to gate real USDC.
// parsePaymentHeader eats a fully-attacker-controlled header (base64-JSON or raw-JSON, arbitrary shape)
// so it must NEVER throw and must never emit an unexpected key/type that a caller might trust.
//
// Oracle:
//   1. never throws on data.toString().
//   2. if it returns non-null, EVERY key ∈ {to, value, nonce, network} AND every value is
//      (string | undefined). A key like "__proto__"/"constructor" or a non-string value (object,
//      number, array — e.g. from `authorization.to` being an object) leaking through is a real finding:
//      the downstream verify() does `terms.to.toLowerCase()` / `BigInt(terms.value)` and would crash or
//      mis-gate on a non-string. So this catches prototype-pollution + unexpected-shape leaks.
//
// A crash artifact = a real finding. If this throws, DO NOT weaken the oracle — capture the counterexample.
//
// Run: node_modules/.bin/jazzer fuzz/parsePaymentHeader.fuzz fuzz/corpus/parsePaymentHeader -- -max_total_time=25
import { parsePaymentHeader } from "../src/payments/x402";

const ALLOWED = new Set(["to", "value", "nonce", "network"]);

export function fuzz(data: Buffer): void {
  const header = data.toString("utf-8");
  const r = parsePaymentHeader(header); // must never throw
  if (r === null) return;
  for (const key of Object.keys(r)) {
    if (!ALLOWED.has(key)) {
      throw new Error(`parsePaymentHeader leaked unexpected key ${JSON.stringify(key)} for input: ${JSON.stringify(header)}`);
    }
    const v = (r as Record<string, unknown>)[key];
    if (v !== undefined && typeof v !== "string") {
      throw new Error(`parsePaymentHeader key ${key} = non-string (${typeof v}) for input: ${JSON.stringify(header)}`);
    }
  }
}
