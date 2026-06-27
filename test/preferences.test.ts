import { describe, expect, it } from "vitest";
import { compatible, parseHeart, type EligPersona } from "../src/match/eligibility";

// Build an eligibility persona from a structured `prefs` block (markets remote so only prefs decide).
const persona = (id: number, prefs: Record<string, unknown>): EligPersona => ({
  id,
  activeMarket: "remote",
  homeMarket: "other",
  parsed: parseHeart(JSON.stringify({ about: "honest prose here", prefs })),
});

describe("structured preference dealbreakers (hard filters)", () => {
  it("race/ethnicity: a stated accept-list excludes a partner outside it (mutual)", () => {
    const a = persona(1, { self: { ethnicity: "white" }, seek: { ethnicities: ["asian"] } });
    const out = persona(2, { self: { ethnicity: "white" } });
    const ok = persona(3, { self: { ethnicity: "asian" }, seek: { ethnicities: ["white"] } });
    expect(compatible(a, out).ok).toBe(false);
    expect(compatible(a, out).reason).toBe("ethnicity");
    expect(compatible(a, ok).ok).toBe(true);
  });

  it("gender/orientation: a partner outside the seek set is filtered", () => {
    const a = persona(1, { self: { gender: "woman" }, seek: { genders: ["woman"] } });
    expect(compatible(a, persona(2, { self: { gender: "man" } })).ok).toBe(false);
    expect(compatible(a, persona(3, { self: { gender: "woman" }, seek: { genders: ["woman"] } })).ok).toBe(true);
  });

  it("age range is mutual", () => {
    const a = persona(1, { self: { age: 30 }, seek: { ageMin: 25, ageMax: 35 } });
    expect(compatible(a, persona(2, { self: { age: 50 } })).reason).toBe("age");
    expect(compatible(a, persona(3, { self: { age: 32 }, seek: { ageMin: 25, ageMax: 40 } })).ok).toBe(true);
  });

  it("languages require at least one shared", () => {
    const a = persona(1, { self: { languages: ["turkish"] }, seek: { languages: ["turkish"] } });
    expect(compatible(a, persona(2, { self: { languages: ["english"] } })).reason).toBe("language");
    expect(compatible(a, persona(3, { self: { languages: ["turkish", "english"] } })).ok).toBe(true);
  });

  it("kids: explicit want vs explicit no is incompatible; open is fine", () => {
    expect(compatible(persona(1, { self: { kids: "want" } }), persona(2, { self: { kids: "no" } })).reason).toBe("kids");
    expect(compatible(persona(1, { self: { kids: "want" } }), persona(3, { self: { kids: "open" } })).ok).toBe(true);
  });

  it("substances: an excluded behaviour is filtered", () => {
    const a = persona(1, { self: { substances: "none" }, seek: { dealbreakers: { substances: ["smoker"] } } });
    expect(compatible(a, persona(2, { self: { substances: "smoker" } })).reason).toBe("substance");
    expect(compatible(a, persona(3, { self: { substances: "social" } })).ok).toBe(true);
  });

  it("missing data never excludes — prose-only hearts and unstated attributes stay compatible", () => {
    const a = persona(1, { self: { ethnicity: "white" }, seek: { ethnicities: ["asian"] } });
    expect(compatible(a, persona(2, {})).ok).toBe(true); // partner stated no ethnicity → not filtered
    const prose = (id: number): EligPersona => ({ id, activeMarket: "remote", homeMarket: "other", parsed: parseHeart("just honest prose, no json") });
    expect(compatible(prose(1), prose(2)).ok).toBe(true);
  });
});
