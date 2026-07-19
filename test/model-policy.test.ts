import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Model-policy guards asserted against PRODUCTION wrangler.toml, injected as PROD_WRANGLER_TOML by
// vitest.config.ts. The suite otherwise binds from wrangler.test.toml, so asserting on `env`
// directly would only ever check the test mirror — which is exactly how both defects below
// survived in production until a manual audit on 2026-07-19:
//   1. MODEL_POOL and REPORT_MODEL carried glm/kimi ids the founder had banned outright.
//   2. The closure judge ran on CHAT_MODEL — also the FIRST entry in MODEL_POOL — so the model
//      HeartElo rates was ruling on its own courtships, while src/heartbench/elo.ts publicly
//      claimed "No self-judging. The model whose strength we fit is NEVER the judge of the outcome."
const toml = (env as unknown as { PROD_WRANGLER_TOML: string }).PROD_WRANGLER_TOML;

const varOf = (name: string): string => {
  const value = toml.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
  if (value === undefined) throw new Error(`${name} not found in production wrangler.toml`);
  return value;
};

const pool = (): string[] =>
  varOf("MODEL_POOL")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// Founder standing rule: Workers AI catalogue only; never these vendors.
const BANNED_VENDOR_FRAGMENTS = ["glm", "kimi", "moonshot", "zai-org"];
const MODEL_VARS = ["GAMBIT_MODEL", "REPORT_MODEL", "CHAT_MODEL", "TOPIC_MODEL", "JUDGE_MODEL", "EMBED_MODEL"];

describe("model policy (production wrangler.toml)", () => {
  it("loads the production config", () => {
    expect(toml, "PROD_WRANGLER_TOML binding missing — check vitest.config.ts").toBeTruthy();
  });

  it("never ships a banned vendor in any model var", () => {
    for (const name of MODEL_VARS) {
      const id = varOf(name).toLowerCase();
      for (const banned of BANNED_VENDOR_FRAGMENTS) {
        expect(id, `${name}="${id}" uses banned vendor "${banned}"`).not.toContain(banned);
      }
    }
  });

  it("never ships a banned vendor inside MODEL_POOL", () => {
    for (const id of pool()) {
      for (const banned of BANNED_VENDOR_FRAGMENTS) {
        expect(id.toLowerCase(), `MODEL_POOL entry "${id}" uses banned vendor "${banned}"`).not.toContain(banned);
      }
    }
  });

  it("keeps every model id on the Workers AI catalogue (@cf/...)", () => {
    for (const name of MODEL_VARS) {
      expect(varOf(name), `${name} must be a Workers AI id (no BYOK, no other provider)`).toMatch(/^@cf\//);
    }
    for (const id of pool()) {
      expect(id, `MODEL_POOL entry "${id}" must be a Workers AI id`).toMatch(/^@cf\//);
    }
  });

  // The load-bearing assertion: this is what makes the public "No self-judging" claim true.
  it("excludes JUDGE_MODEL from MODEL_POOL so no model ever judges itself", () => {
    expect(pool()).not.toContain(varOf("JUDGE_MODEL"));
  });

  it("sets JUDGE_MODEL explicitly, so closure never falls back onto a contender", () => {
    // closure.ts resolves JUDGE_MODEL -> CHAT_MODEL -> GAMBIT_MODEL. Both fallbacks sit in the
    // pool, so an unset JUDGE_MODEL silently restores the self-judging bug.
    expect(varOf("JUDGE_MODEL")).toBeTruthy();
    expect(pool(), "documents why the CHAT_MODEL fallback is unsafe").toContain(varOf("CHAT_MODEL"));
  });
});
