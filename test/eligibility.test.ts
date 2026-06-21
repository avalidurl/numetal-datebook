import { describe, expect, it } from "vitest";
import { coldScore, compatible, parseHeart, type EligPersona } from "../src/match/eligibility";

const mk = (id: number, market: string, intent: string, text: string, dealbreakers: string[] = []): EligPersona => ({
  id,
  activeMarket: market,
  homeMarket: market,
  parsed: { text: text.toLowerCase(), dealbreakers, intent },
});

describe("match eligibility", () => {
  it("parses a JSON heart's dealbreakers + intent (lowercased)", () => {
    const p = parseHeart(JSON.stringify({ about: "Quiet HARDWARE hacker", relationship_intent: "Long-Term", dealbreakers: ["Smoking", "Contempt"] }));
    expect(p.intent).toBe("long-term");
    expect(p.dealbreakers).toContain("smoking");
    expect(p.text).toContain("hardware");
  });

  it("requires a shared (or remote/online) market", () => {
    expect(compatible(mk(1, "bay_area", "", "a"), mk(2, "nyc", "", "b")).ok).toBe(false);
    expect(compatible(mk(1, "bay_area", "", "a"), mk(2, "bay_area", "", "b")).ok).toBe(true);
    expect(compatible(mk(1, "remote", "", "a"), mk(2, "nyc", "", "b")).ok).toBe(true);
  });

  it("blocks flatly-incompatible intents but allows soft ones", () => {
    expect(compatible(mk(1, "remote", "casual", "a"), mk(2, "remote", "long-term", "b")).ok).toBe(false);
    expect(compatible(mk(1, "remote", "dating", "a"), mk(2, "remote", "long-term", "b")).ok).toBe(true);
  });

  it("blocks a dealbreaker present in the other heart (both directions)", () => {
    expect(compatible(mk(1, "remote", "", "loves anything", ["smoking"]), mk(2, "remote", "", "i enjoy smoking on weekends")).ok).toBe(false);
    expect(compatible(mk(1, "remote", "", "i enjoy smoking on weekends"), mk(2, "remote", "", "loves anything", ["smoking"])).ok).toBe(false);
  });

  it("cold-start scores shared market+intent+overlap above nothing", () => {
    const shared = coldScore(mk(1, "bay_area", "long-term", "hiking books"), mk(2, "bay_area", "long-term", "hiking books"));
    const none = coldScore(mk(1, "remote", "", "alpha"), mk(2, "nyc", "", "omega"));
    expect(shared).toBeGreaterThan(none);
  });
});
