import { describe, expect, it } from "vitest";
import { FREE_FLOOR, FREE_MAX, freeQuotaForUsd, perkForUsd } from "../src/economics/numetal";

describe("freeQuotaForUsd — 3 free base, 50 at $30, doubling, capped", () => {
  it("gives the free base (3/day) below the $30 floor — everyone, no holding needed", () => {
    for (const usd of [0, 1, 15, 29.99]) expect(freeQuotaForUsd(usd)).toBe(FREE_FLOOR);
    expect(FREE_FLOOR).toBe(3);
  });

  it("jumps to 50 at $30, then doubles each $30 step", () => {
    expect(freeQuotaForUsd(30)).toBe(50);
    expect(freeQuotaForUsd(59.99)).toBe(50); // still in the first $30 band
    expect(freeQuotaForUsd(60)).toBe(100);
    expect(freeQuotaForUsd(90)).toBe(200);
    expect(freeQuotaForUsd(120)).toBe(400);
  });

  it("is bounded by FREE_MAX (500) so a whale can't open an unbounded free tap", () => {
    expect(FREE_MAX).toBe(500);
    expect(freeQuotaForUsd(150)).toBe(500); // 50·2^4 = 800 → capped to 500
    expect(freeQuotaForUsd(1_000_000)).toBe(FREE_MAX);
  });

  it("treats junk / non-finite input as the free base (everyone still gets 3)", () => {
    expect(freeQuotaForUsd(Number.NaN)).toBe(FREE_FLOOR);
    expect(freeQuotaForUsd(-50)).toBe(FREE_FLOOR);
    expect(freeQuotaForUsd(Number.POSITIVE_INFINITY)).toBe(FREE_FLOOR);
  });

  it("honors runtime knob overrides", () => {
    expect(freeQuotaForUsd(60, { step: 30, base: 30, max: 1000 })).toBe(60);
    expect(freeQuotaForUsd(60, { max: 55 })).toBe(55); // cap below the doubled value
    expect(freeQuotaForUsd(10, { floor: 1 })).toBe(1); // floor override
  });
});

describe("perkForUsd — USD-pegged venue-perk bands", () => {
  it("maps USD held to a sane band (no 10%-of-supply absurdity)", () => {
    expect(perkForUsd(0)).toBe("none");
    expect(perkForUsd(29)).toBe("none");
    expect(perkForUsd(30)).toBe("badge");
    expect(perkForUsd(90)).toBe("priority");
    expect(perkForUsd(300)).toBe("discount");
    expect(perkForUsd(900)).toBe("founder");
  });
});
