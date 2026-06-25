import { describe, expect, it } from "vitest";
import { FREE_MAX, freeQuotaForUsd, perkForUsd } from "../src/economics/numetal";

describe("freeQuotaForUsd — $30 floor, doubling every $30", () => {
  it("gives 0 free messages below the $30 floor", () => {
    for (const usd of [0, 1, 15, 29.99]) expect(freeQuotaForUsd(usd)).toBe(0);
  });

  it("doubles each $30 step", () => {
    expect(freeQuotaForUsd(30)).toBe(5);
    expect(freeQuotaForUsd(59.99)).toBe(5); // still in the first $30 band
    expect(freeQuotaForUsd(60)).toBe(10);
    expect(freeQuotaForUsd(90)).toBe(20);
    expect(freeQuotaForUsd(120)).toBe(40);
    expect(freeQuotaForUsd(150)).toBe(80);
    expect(freeQuotaForUsd(180)).toBe(160);
  });

  it("is bounded by FREE_MAX so a whale can't open an unbounded free tap", () => {
    expect(freeQuotaForUsd(1_000_000)).toBe(FREE_MAX);
    expect(freeQuotaForUsd(300)).toBeLessThanOrEqual(FREE_MAX);
  });

  it("treats junk / non-finite input as 0 (fail-safe)", () => {
    expect(freeQuotaForUsd(Number.NaN)).toBe(0);
    expect(freeQuotaForUsd(-50)).toBe(0);
    expect(freeQuotaForUsd(Number.POSITIVE_INFINITY)).toBe(0); // non-finite → fail-safe to no free tier
  });

  it("honors runtime knob overrides", () => {
    expect(freeQuotaForUsd(60, { step: 30, base: 3, max: 1000 })).toBe(6);
    expect(freeQuotaForUsd(60, { max: 5 })).toBe(5); // cap below the doubled value
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
