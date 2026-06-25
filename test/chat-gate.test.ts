import { describe, expect, it } from "vitest";
import { chatOpenFor } from "../src/routes/chat";
import type { Env } from "../src/env";

const FOUNDER = "0x36de990133D36d7E3DF9a820aA3eDE5a2320De71"; // gokhan.eth
const OTHER = "0x1111111111111111111111111111111111111111";
const env = (o: Partial<Env> = {}) => o as Env;

describe("chatOpenFor — pre-launch closed test gate", () => {
  it("always allows the founder wallet (case-insensitive)", () => {
    expect(chatOpenFor(env(), FOUNDER)).toBe(true);
    expect(chatOpenFor(env(), FOUNDER.toLowerCase())).toBe(true);
  });

  it("blocks everyone else while closed", () => {
    expect(chatOpenFor(env(), OTHER)).toBe(false);
  });

  it("opens to everyone once CHAT_LAUNCHED is set", () => {
    expect(chatOpenFor(env({ CHAT_LAUNCHED: "true" }), OTHER)).toBe(true);
    expect(chatOpenFor(env({ CHAT_LAUNCHED: "1" }), OTHER)).toBe(true);
  });

  it("honors the CHAT_WHITELIST while still allowing the founder", () => {
    const e = env({ CHAT_WHITELIST: " 0xAAAA000000000000000000000000000000000001 , 0xbbbb000000000000000000000000000000000002 " });
    expect(chatOpenFor(e, "0xaaaa000000000000000000000000000000000001")).toBe(true);
    expect(chatOpenFor(e, "0xBBBB000000000000000000000000000000000002")).toBe(true);
    expect(chatOpenFor(e, FOUNDER)).toBe(true); // founder always allowed
    expect(chatOpenFor(e, OTHER)).toBe(false);
  });
});
