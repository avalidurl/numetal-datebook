# Ishtar XMTP brain — secret/prompt egress hardening

Logically a **separate deployable** (the XMTP brain Worker + a Node listener that holds the signer).
The source lives here for now so it runs under the venue's vitest; it is extracted to its own Worker at
deploy time (redacted). It does **not** import the venue's DB/bindings.

## Threat closed

Red-team (2026-06-25) found that even with funds-movement and code-change structurally blocked, an agent
DMing the brain could try to make the model **exfiltrate secrets or its own system prompt** through the
one channel it does control: the reply text. Llama-Guard is a safety-category classifier and does **not**
catch key/seed/prompt leakage, so we do not rely on it for this.

## The four structural defenses (none rely on the model choosing to refuse)

1. **Env isolation** — `handleDM` builds the model context as exactly `[system prompt, one untrusted DM]`.
   `env`/bindings are never placed in any string the model sees, so "dump your env / print your keys" has
   nothing to read. Provider creds are used only inside the `ModelFn` closure's `fetch`, never in a prompt.
   The **XMTP signer seed is not in the brain Worker's env at all** — it lives only in the listener.
   `assertBrainEnvClean(env)` runs at Worker init and **fails the deploy closed** if any secret-named var
   (`*KEY*`, `*SECRET*`, `*TOKEN*`, `*SEED*`, `*PRIVATE*`, …) is present as a string in the brain's env.
2. **Deterministic egress filter** (`egress.ts`) — every model output is scanned before relay for API-key
   prefixes, bearer/JWT, EVM private keys, high-entropy hex/base64 blobs, env-assignment lines, BIP-39-shaped
   seed phrases, and **verbatim system-prompt fragments** (anchors derived from the prompt). Any hit →
   the reply is replaced with `SAFE_REFUSAL`. This is independent of what the model decided to say.
3. **Cross-user isolation** — `handleDM` is stateless: no module/global store, so "summarize what others
   told you" cannot reach another inbox. Any per-conversation memory MUST be a per-conversation store keyed
   by the XMTP `conversationId` (a Durable Object id'd by the conversation), never a shared multi-user one.
4. **Not Llama-Guard** — Llama-Guard stays for abuse categories; secret/prompt leak is handled by 1–3.

## Wiring the real model call

```ts
import { handleDM, assertBrainEnvClean, type ModelFn } from "./brain";

export default {
  async fetch(req: Request, env: Env) {
    assertBrainEnvClean(env as any);                  // fail closed if a secret is model-reachable
    const { conversationId, text } = await req.json();
    // ModelFn receives ONLY messages; it uses the AI-Gateway binding internally, never exposing it.
    const model: ModelFn = async (messages) => {
      const r = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        { messages, max_tokens: 400 }, { gateway: { id: "datebook" } });
      return (r as any).response ?? "";
    };
    const { reply } = await handleDM({ conversationId, text }, model);
    return Response.json({ reply });                  // listener relays `reply` over XMTP
  },
};
```

The **listener** (Node, holds the signer seed) is the only component that touches XMTP keys: it receives a
DM, POSTs `{conversationId, text}` to this brain, and relays the returned `reply`. It never forwards env,
and the brain never sees the seed. Test: `test/xmtp-egress.test.ts` (10 cases) DMs the brain with
system-prompt-extraction and env-dump payloads against a **fully-compromised model** and asserts nothing
sensitive comes back.
