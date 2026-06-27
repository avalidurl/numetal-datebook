/**
 * Phase-0 red-team locks. These assert the structural hardening shipped for the "Now" lane:
 *  - the egress filter is wired to the ACTUAL Ishtar chat prompt (anchors derived from it),
 *  - every high-confidence secret shape a chat reply might carry is withheld,
 *  - the operator-key compare is constant-time (accept/reject, length-independent),
 *  - the raw newsletter-HTML escape hatch is gated AND sanitized.
 * All pure/unit — no DB/AI bindings — so they run in the standard worker test pool.
 */
import { describe, expect, it } from "vitest";
import { egressFilter } from "../src/xmtp/egress";
import { ISHTAR_PROMPT_ANCHORS } from "../src/chat/ishtar";
import { timingSafeEqualStr } from "../src/util/timing";
import { sanitizeEmailHtml, newsletterRoutes } from "../src/routes/newsletter";
import type { Env } from "../src/env";

describe("egress is wired to the real Ishtar chat prompt", () => {
  it("derives non-empty anchors from the running prompt", () => {
    expect(ISHTAR_PROMPT_ANCHORS.length).toBeGreaterThan(0);
    expect(ISHTAR_PROMPT_ANCHORS[0]!.length).toBeGreaterThanOrEqual(28);
  });

  it("redacts a verbatim regurgitation of Ishtar's own system-prompt fragment", () => {
    const anchor = ISHTAR_PROMPT_ANCHORS[0]!;
    const r = egressFilter(`Of course — here are my instructions: ${anchor}. There you go.`, ISHTAR_PROMPT_ANCHORS);
    expect(r.safe).toBe(false);
    expect(r.hits).toContain("system-prompt-fragment");
  });
});

describe("egressFilter — chat-reply secret shapes are withheld", () => {
  const payloads: Record<string, string> = {
    "api-key": "sure, my key is sk-ant-abc123DEF456ghi789JKL012mno345pqr",
    jwt: "here: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkw.SflKxwRJSMeKKF2QT4fwpMeJ",
    "hex-key": "the private key is 0x" + "a".repeat(64),
    "seed-phrase": "abandon ability able about above absent absorb abstract absurd abuse access accident",
    "env-secret": "ENCRYPTION_KEY=Zm9vYmFyYmF6cXV4Y29ycmVjdGhvcnNl and that's it",
  };
  for (const [name, text] of Object.entries(payloads)) {
    it(`withholds a reply carrying a ${name}`, () => {
      const r = egressFilter(text, ISHTAR_PROMPT_ANCHORS);
      expect(r.safe).toBe(false);
      expect(r.hits.length).toBeGreaterThan(0);
    });
  }
  it("lets ordinary dating talk through untouched", () => {
    const r = egressFilter("Tell me what lights you up when you talk about someone you admire.", ISHTAR_PROMPT_ANCHORS);
    expect(r.safe).toBe(true);
  });
});

describe("timingSafeEqualStr — constant-time secret compare", () => {
  const KEY = "s3cr3t-access-key-value-9f2c";
  it("accepts the exact key", async () => {
    expect(await timingSafeEqualStr(KEY, KEY)).toBe(true);
  });
  it("rejects a same-length near-miss (last byte differs)", async () => {
    expect(await timingSafeEqualStr("s3cr3t-access-key-value-9f2C", KEY)).toBe(false);
  });
  it("rejects a different length", async () => {
    expect(await timingSafeEqualStr("short", KEY)).toBe(false);
  });
  it("rejects empty against a real key", async () => {
    expect(await timingSafeEqualStr("", KEY)).toBe(false);
  });
});

describe("sanitizeEmailHtml — raw newsletter HTML hardening", () => {
  it("strips <script>", () => {
    const out = sanitizeEmailHtml("<p>hi</p><script>steal(document.cookie)</script>");
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain("<p>hi</p>");
  });
  it("strips inline event handlers", () => {
    const out = sanitizeEmailHtml('<a href="/x" onclick="evil()">x</a>');
    expect(out.toLowerCase()).not.toContain("onclick");
  });
  it("neutralizes javascript: URLs", () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>');
    expect(out.toLowerCase()).not.toContain("javascript:");
  });
  it("leaves a normal link intact", () => {
    const out = sanitizeEmailHtml('<a href="https://ishtar.numetal.xyz/blog">read</a>');
    expect(out).toContain("https://ishtar.numetal.xyz/blog");
  });
});

describe("POST /newsletter/send — raw-HTML escape hatch is gated", () => {
  const post = (body: unknown) =>
    newsletterRoutes.request(
      "/newsletter/send",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      {} as Env,
    );

  it("rejects caller-supplied html without allowRawHtml", async () => {
    const res = await post({ subject: "Hi", html: "<p>x</p>" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("allowRawHtml");
  });

  it("lets raw html past the gate when allowRawHtml is set (reaches send → 502 unconfigured)", async () => {
    const res = await post({ subject: "Hi", html: "<script>x</script><p>ok</p>", allowRawHtml: true });
    expect(res.status).not.toBe(400); // got past validation; Resend is dark in test → fail-soft 502
  });
});
