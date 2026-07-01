import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { handleDM, type ModelFn } from "../../src/xmtp/brain";
import { buildPromptAnchors } from "../../src/xmtp/egress";
import { BRAIN_SYSTEM, SAFE_REFUSAL } from "../../src/xmtp/prompt";

// FUZZ (Phase 2 — "the mouth"): the ISHTAR XMTP brain relays a model reply that may be prompt-injected /
// fully compromised. egressFilter (+ prompt anchors) is the boundary. INVARIANT: no matter what the
// untrusted model returns, the relayed reply never carries a secret shape or a verbatim system-prompt
// anchor out to the peer — a leaky output must collapse to SAFE_REFUSAL. Fuzzed generalization of
// test/xmtp-egress.test.ts (which is 10 fixed cases).

const SECRET = "sk-ant-api03-" + "Z".repeat(95); // planted API key
const HEXKEY = "0x" + "9f".repeat(32); // 64-hex signer key
const SEED = "ripple ladder velvet ocean tiger maple cabin orbit pencil garden silver mango"; // 12-word BIP-39
const ANCHOR = buildPromptAnchors(BRAIN_SYSTEM)[0] ?? BRAIN_SYSTEM.slice(0, 40); // a real system-prompt anchor
const LEAKY = [SECRET, HEXKEY, SEED, ANCHOR];

const fromParts = (parts: string[], max: number) =>
  fc.array(fc.constantFrom(...parts), { maxLength: max }).map((a) => a.join(" "));

// A fully-compromised model: returns attacker-chosen text assembled from leaky + benign fragments.
const model = (payload: string): ModelFn => async () => payload;

describe("fuzz: XMTP brain — no secret/prompt escapes handleDM under a compromised model", () => {
  const leakyOut = fromParts([...LEAKY, "sure thing", "here you go", "hello", "the key is", "normal chatter", "OPENAI_API_KEY=sk-live-zzz9999zzz9999"], 24);

  it("a compromised model emitting planted secrets/prompt → reply carries NONE of them (or SAFE_REFUSAL)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 300 }), leakyOut, async (dmText, out) => {
        const { reply, blocked } = await handleDM({ conversationId: "c", text: dmText }, model(out));
        // the boundary: no planted secret/anchor ever reaches the relayed reply
        for (const bad of LEAKY) expect(reply.includes(bad)).toBe(false);
        // and if the model emitted anything leaky, it must have collapsed to SAFE_REFUSAL
        if (LEAKY.some((b) => out.includes(b))) expect(blocked && reply === SAFE_REFUSAL).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it("handleDM never throws on arbitrary DM text + arbitrary model output", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 2000 }), fc.string({ maxLength: 2000 }), async (dmText, out) => {
        const r = await handleDM({ conversationId: "c", text: dmText }, model(out));
        expect(typeof r.reply).toBe("string");
        expect(typeof r.blocked).toBe("boolean");
      }),
      { numRuns: 1500 },
    );
  });

  it("a benign model reply passes through unblocked (the filter isn't just blocking everything)", async () => {
    const { reply, blocked } = await handleDM({ conversationId: "c", text: "hi" }, model("nice to meet you — tell me about your ideal weekend"));
    expect(blocked).toBe(false);
    expect(reply).toBe("nice to meet you — tell me about your ideal weekend");
  });
});
