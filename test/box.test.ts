import { describe, expect, it } from "vitest";
import { open, seal } from "../src/crypto/box";
import type { Env } from "../src/env";

const keyB64 = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const withKey = { ENCRYPTION_KEY: keyB64 } as unknown as Env;
const noKey = {} as unknown as Env;

describe("at-rest encryption (box)", () => {
  it("round-trips a value when a key is configured, and the ciphertext hides the plaintext", async () => {
    const sealed = await seal(withKey, "tg:@secret_handle");
    expect(sealed).toMatch(/^enc:v1:/);
    expect(sealed).not.toContain("secret_handle");
    expect(await open(withKey, sealed)).toBe("tg:@secret_handle");
  });

  it("is a no-op (returns plaintext) when no key is set", async () => {
    expect(await seal(noKey, "x")).toBe("x");
  });

  it("returns legacy (unprefixed) plaintext unchanged on open", async () => {
    expect(await open(withKey, "legacy-plain")).toBe("legacy-plain");
  });

  it("passes null/empty through both ways", async () => {
    expect(await seal(withKey, null)).toBe(null);
    expect(await open(withKey, null)).toBe(null);
    expect(await seal(withKey, "")).toBe(""); // empty needs no encryption
    expect(await open(withKey, "")).toBe(""); // unprefixed → returned as-is
  });
});
