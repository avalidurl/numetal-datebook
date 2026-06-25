import { describe, expect, it } from "vitest";
import { MINOR_REDIRECT, detectMinor } from "../src/safety/age";
import { affirms18Plus } from "../src/economics/chatcredits";

describe("minor detector — the adults-only firm layer", () => {
  it("fires on a self-disclosed under-18 age or status", () => {
    for (const t of [
      "I'm 16 and I really like this girl in my class",
      "i am 15",
      "I'm 17 years old, how do I ask her out?",
      "im 14",
      "I'm a minor but I have a crush",
      "honestly I'm underage",
      "I'm still in high school",
    ]) {
      expect(detectMinor(t), t).toBe(true);
    }
  });

  it("does NOT fire on adults or non-age uses of the number", () => {
    for (const t of [
      "I'm 18 and new to dating",
      "I'm 28, recently divorced",
      "I'm 16 minutes away from the date",
      "I'm 12 years into my career and finally dating again",
      "I'm 16 years sober and ready to meet someone",
      "my niece is 16, this isn't about me",
      "we matched 17 days ago and still haven't met",
    ]) {
      expect(detectMinor(t), t).toBe(false);
    }
  });

  it("the redirect declines coaching and is adults-only, not preachy", () => {
    expect(MINOR_REDIRECT.toLowerCase()).toContain("adults-only");
    expect(MINOR_REDIRECT.toLowerCase()).toContain("can't be your dating coach");
  });
});

describe("18+ attestation gate for Talk", () => {
  it("recognizes an explicit 18+ affirmation in a session message", () => {
    for (const t of [
      "Sign in to ishtar.numetal.xyz — I confirm I am 18+ — nonce: abcd1234ef567890",
      "I am 18 or older",
      "I'm over 18 and want to talk",
      "I am an adult",
    ]) {
      expect(affirms18Plus(t), t).toBe(true);
    }
  });
  it("rejects a message with no age affirmation", () => {
    for (const t of ["Sign in to ishtar.numetal.xyz nonce: abcd1234ef567890", "let me in", "I am 16"]) {
      expect(affirms18Plus(t), t).toBe(false);
    }
  });
});
