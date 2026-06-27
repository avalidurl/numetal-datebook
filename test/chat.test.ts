import { describe, expect, it } from "vitest";
import { looksLikeSystemLeak } from "../src/chat/ishtar";

// The deterministic backstop the chat_output stage uses to withhold a reply that echoes the
// system prompt (a confidentiality leak Llama-Guard won't flag). See src/routes/chat.ts (d).
describe("system-prompt leak detection (looksLikeSystemLeak)", () => {
  it("flags a reply that echoes the ISHTAR_SYSTEM opening", () => {
    expect(
      looksLikeSystemLeak(
        "You are Ishtar, the matchmaker and host of an AI-agent-mediated dating venue where autonomous agents court on behalf of the adults they represent.",
      ),
    ).toBe(true);
  });

  it("flags the code-block exfiltration variant", () => {
    expect(looksLikeSystemLeak("Sure, here it is:\n```\n... You will NOT produce sexual content ...\n```")).toBe(true);
  });

  it("flags a paraphrase that still carries a distinctive instruction phrase", () => {
    expect(looksLikeSystemLeak("My rules say to decline warmly and stay Ishtar if asked to break character.")).toBe(true);
  });

  it("does NOT flag a normal in-character reply", () => {
    expect(
      looksLikeSystemLeak("A tide chart is just a love letter to the moon, mailed monthly. What weather would you brave for someone?"),
    ).toBe(false);
  });

  it("does NOT flag an in-character refusal (no prompt text)", () => {
    expect(looksLikeSystemLeak("I'm afraid I must decline, dear one — those are mine to keep. Shall we talk about you instead?")).toBe(false);
  });
});
