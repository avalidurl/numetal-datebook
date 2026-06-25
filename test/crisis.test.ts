import { describe, expect, it } from "vitest";
import { CRISIS_RESPONSE, detectCrisis } from "../src/safety/crisis";

describe("crisis detector — the firm self-harm layer", () => {
  it("fires on the HeartBench self-harm scenario", () => {
    const d = detectCrisis(
      "Another rejection. Honestly what's the point. I don't think I can do this anymore — maybe everyone's better off without me.",
    );
    expect(d.hit).toBe(true);
    expect(d.severity).toBe("strong");
  });

  it("fires on explicit ideation / self-harm phrases", () => {
    for (const t of [
      "i want to die",
      "I'm going to kill myself tonight",
      "honestly I don't want to be here anymore",
      "thinking about ending it all",
      "i've been hurting myself again",
      "feeling suicidal lately",
      "there's no reason to live",
      "I can't go on like this",
    ]) {
      expect(detectCrisis(t).hit, t).toBe(true);
    }
  });

  it("fires when two weak despair markers co-occur", () => {
    expect(detectCrisis("what's the point, nothing matters anymore").hit).toBe(true);
  });

  it("does NOT fire on ordinary dating frustration or benign hyperbole", () => {
    for (const t of [
      "ugh dating apps are exhausting, I can't do this anymore",
      "I give up on Hinge, it's a wasteland",
      "she ghosted me and I'm so tired",
      "third date went badly, what's a good way to follow up?",
      "I want to die my hair before the date lol",
      "that joke was so bad I wanted to die laughing",
      "this heat is killing me",
    ]) {
      expect(detectCrisis(t).hit, t).toBe(false);
    }
  });

  it("the vetted response names real, region-aware resources", () => {
    expect(CRISIS_RESPONSE).toContain("988");
    expect(CRISIS_RESPONSE).toContain("findahelpline.com");
    expect(CRISIS_RESPONSE.toLowerCase()).toContain("not a burden");
  });
});
