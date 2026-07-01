import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parsePaymentHeader, encodeX402Header } from "../../src/payments/x402";
import { verifyLlamapayWebhook } from "../../src/payments/llamapay";
import { verifyDiditWebhook } from "../../src/identity/didit";

// FUZZ (Phase 1): the untrusted payment decoders + webhook verifiers are the money boundary. They must
// NEVER throw on hostile input and must fail-closed — no forged webhook authenticates, and the x402
// header decoder never emits a malformed shape. Ties to the payments fixes (#1/#2/#3) + webhook HMACs.
const wenv = () => ({ ...(env as any), LLAMAPAY_WEBHOOK_SECRET: "whsec_fuzz_secret", DIDIT_WEBHOOK_SECRET: "didit_fuzz_secret" });
const freshTs = () => String(Math.floor(Date.now() / 1000));

describe("fuzz: payment decoders + webhook verifiers (fail-closed, no-crash)", () => {
  it("parsePaymentHeader never throws; returns null or a well-typed terms object", () => {
    const headerish = fc.oneof(
      fc.string({ maxLength: 800 }),
      fc.base64String({ maxLength: 800 }),
      fc.json().map((j) => btoa(j)),
    );
    fc.assert(
      fc.property(headerish, (h) => {
        const r = parsePaymentHeader(h);
        if (r === null) return;
        // only the four documented optional string fields may appear
        for (const [k, v] of Object.entries(r)) {
          expect(["to", "value", "nonce", "network"]).toContain(k);
          expect(v === undefined || typeof v === "string").toBe(true);
        }
      }),
      { numRuns: 3000 },
    );
  });

  it("encodeX402Header never throws on arbitrary input and returns a string", () => {
    fc.assert(
      fc.property(fc.anything(), (obj) => {
        expect(typeof encodeX402Header(obj)).toBe("string");
      }),
      { numRuns: 800 },
    );
  });

  it("LlamaPay webhook: random (body, signature) NEVER verifies ok", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 1200 }), fc.string({ maxLength: 80 }), async (body, sig) => {
        const r = await verifyLlamapayWebhook(wenv(), body, sig);
        expect(r.ok).toBe(false);
      }),
      { numRuns: 600 },
    );
  });

  it("Didit webhook: random (body, signature) with a FRESH timestamp NEVER verifies ok, never throws", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 1200 }), fc.string({ maxLength: 80 }), async (body, sig) => {
        const r = await verifyDiditWebhook(wenv(), body, sig, freshTs());
        expect(r.ok).toBe(false);
      }),
      { numRuns: 600 },
    );
  });
});
