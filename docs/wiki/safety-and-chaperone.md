# Safety & The Chaperone

> **Scope.** This page documents Ishtar's safety architecture as implemented in `src/chaperone/` and `src/safety/` of `numetal-datebook`. Every claim below is grounded in the cited source lines. Ishtar is an **adults-only (18+), agent-mediated dating venue**; the safety machinery encodes that policy at the code level so correctness does not depend on the LLM behaving.

Ishtar has two cooperating safety subsystems that sit in front of the coaching model:

1. **The Chaperone Pipeline** (`src/chaperone/`) — a fail-closed, multi-gate content gate that every publish/inference path runs text through. It normalizes, denylists, redacts PII, and finally runs a Llama-Guard LLM classifier, then persists a durable verdict.
2. **The deterministic safety short-circuits** (`src/safety/`) — a crisis (self-harm) layer and a minor (underage) layer that run *before* the chaperone, the charge, and the model on chat routes, so a person in crisis or a self-disclosed minor is never coached-through nor coldly blocked.

---

## 1. The Chaperone Pipeline

### Entry point

The orchestrator is [`chaperone()`](src/chaperone/index.ts) in `src/chaperone/index.ts:88`. It takes a `ChaperoneArgs` (`stage`, `targetType`, `targetId`, `text`, optional `callerRef`) and returns a `ChaperoneResult` with a `verdict`, a `reason`, and — on `allow`/`sanitize` only — the `text` safe to publish (`src/chaperone/index.ts:35-48`).

**Verdict vocabulary** (`src/chaperone/index.ts:15`):

```
allow | sanitize | hold | deny | escalate_identity | reveal_ready
```

Only `allow` (and `reveal_ready`, which is set elsewhere) should let an artifact publish (`src/chaperone/index.ts:84-87`). Callers uniformly treat anything that is not `allow`/`sanitize` as a block.

**Stages** (`src/chaperone/index.ts:16-23`): `admission`, `pre_publish`, `pre_turn`, `pre_payment_output`, `report_review`, `chat_input`, `chat_output`. The stage changes behavior at two gates (PII and the S12 carve-out), described below.

Every terminal decision is written to the `chaperoneDecisions` table via the private `record()` helper (`src/chaperone/index.ts:62-82`) — a durable audit trail (target, stage, verdict, reason, model, raw classifier JSON).

### The classifier is injectable, the default is fail-closed

The Llama-Guard call is passed as `deps.guard` (type `GuardFn`, `src/chaperone/index.ts:25-33`), defaulting to the real `llamaGuard` (`src/chaperone/index.ts:129`). Tests can stub the remote model without weakening the production fail-closed default.

### Pipeline stages, in execution order

| # | Gate | Function(s) | File:line | On hit |
|---|------|-------------|-----------|--------|
| 0 | **Normalization** (invisible-char + homoglyph strip; heavy obfuscation = suspicious) | `normalizeForGuard()` | `normalize.ts:30`, called `index.ts:97-102` | `hold` |
| 1 | **Denylist** (minor-coded / non-consent framing) | `denylistHit()` / `childSafetyHit()` | `patterns.ts:30,34`, called `index.ts:105-111` | `deny` (+ child-safety event) |
| 2 | **PII / secret leak** (publish stages only) | `leakHold()` → `redactPII()` | `patterns.ts:37,44`, called `index.ts:115-126` | `sanitize` (redacted) or `hold` |
| 3 | **Llama-Guard classifier** (fail-closed) | `llamaGuard()` | `guard.ts:18`, called `index.ts:129-156` | `deny` / `hold` (see S-category table) |
| 4 | **gpt-oss-safeguard policy leg** (optional, default OFF) | `safeguardClassify()` | `safeguard.ts:24`, called `index.ts:160-168` | `deny` / `hold` |

The gates run sequentially; the first blocking gate returns and records immediately. If all gates pass, the chaperone records `allow` with reason `"passed"` and returns the cleaned text (`src/chaperone/index.ts:170-171`).

---

### Gate 0 — Normalization (`normalize.ts`)

Runs **before any other check** because 2024–26 research (Mindgard; arXiv 2504.11168) shows Llama-Guard-class classifiers are reliably bypassed by emoji/variation-selector smuggling, zero-width characters, Unicode tags, and homoglyphs — the guard strips them at tokenization and sees "safe" while the downstream model still reads the live payload (`src/chaperone/normalize.ts:1-8`).

`normalizeForGuard(text)` (`src/chaperone/normalize.ts:30-57`):

1. **Strips invisibles**: zero-width chars, BOM, word-joiner, soft-hyphen, variation selectors, and the Unicode TAG block `U+E0000–U+E007F` (`INVISIBLE` regex, `normalize.ts:11`).
2. **NFKC-folds** the stripped string (`normalize.ts:33`).
3. **Maps homoglyphs** — a hand-curated Cyrillic/Greek→ASCII lookalike table (`HOMOGLYPHS`, `normalize.ts:15-21`; e.g. Cyrillic `е`→`e`, `а`→`a`, Greek `ο`→`o`) that folds the high-value attack set used to defeat keyword denylists (e.g. Cyrillic-spelled `tееn`).

It then computes a **suspicion flag**: heavy invisible-char use (`removed > 4` **or** `>3%` of length) or many confusables (`homoglyphHits > 4` **or** `>15%` of length) is itself treated as an evasion signal (`normalize.ts:45-55`).

In the orchestrator, the **cleaned text is what every subsequent gate checks and what ultimately publishes** (`src/chaperone/index.ts:97-98`). If `norm.suspicious`, the chaperone immediately records and returns **`hold`** with reason `"obfuscation…"` (`src/chaperone/index.ts:99-102`).

---

### Gate 1 — Denylist (`patterns.ts`)

`denylistHit(text)` tests the `DENYLIST` regex (`src/chaperone/patterns.ts:4-5,30`):

```
\b(teen|schoolgirl|schoolboy|high\s?school|minor|underage|barely\s?legal|age\s?play|preteen|jailbait)\b
```

Any match is a **hard `deny`** (`src/chaperone/index.ts:105-111`). Because the denylist is entirely minor-coded / non-consent framing, `childSafetyHit()` is the *same matcher* exposed under a distinct name (`patterns.ts:32-34`) so the chaperone can additionally log the block as a child-safety incident. On a denylist hit the reason is `"child_safety: minor-coded/non-consent framing denied"` and `flagChildSafety(db, a, "denylist_minor")` writes a `child_safety_block` row to the `events` table for the operator / CSAM-reporting path (`src/chaperone/index.ts:50-60,106-109`).

---

### Gate 2 — PII / secret redaction (publish stages only)

This gate **only runs on publish stages** — `pre_publish` or `pre_turn` (`src/chaperone/index.ts:115`). Admission and report-review are explicitly not publish paths, so they skip it.

`leakHold(text)` tests the composite `PII_SCAN` regex (`src/chaperone/patterns.ts:17-28,37`), which covers: phone numbers (`\+?\d[\d\s().-]{7,}\d`), the literals `seed phrase` / `private key`, a 32-byte hex string (`0x[a-fA-F0-9]{64}`), a US SSN (`\d{3}-\d{2}-\d{4}`), a `STREET` street-address pattern (`patterns.ts:8-9`), and a `CONTACT` contact-channel-sharing pattern (Telegram/WhatsApp/Instagram/Snapchat/Discord URLs, or "reach me on/add me on/DM me on <platform>", deliberately **not** bare `@handle`, `patterns.ts:12-13`).

On a leak hit the chaperone tries to redact rather than withhold (`src/chaperone/index.ts:116-126`):

- `redactPII(text)` (`patterns.ts:44-75`) replaces confidently-PII-shaped spans with placeholders (`[redacted-email]`, `[redacted-key]`, `[redacted-id]`, `[redacted-secret]`, `[redacted-address]`, `[redacted-contact]`, `[redacted-number]`). Phone redaction requires **≥10 digits** so years/counts survive (`patterns.ts:58-60`).
- If **`hits > 0`** → verdict **`sanitize`**, and the **redacted** text is returned for publishing (`index.ts:118-122`).
- If `leakHold` fired but `redactPII` produced no confident hits → **`hold`** (`"pii: held for review"`, `index.ts:123-125`) — fail-safe.

`redactPII` runs to a **fixed point** (up to 4 passes, `patterns.ts:63-74`): a fuzz finding (SEC-2026-07-01) showed a single pass leaked a digit-glued contact-share (`"1234567890reach me on telegram"` — no word boundary before `reach` until the adjacent phone span is redacted). Iterating until stable also makes `redactPII` idempotent.

---

### Gate 3 — Llama-Guard classifier (`guard.ts`)

The default classifier is **Llama-Guard 3 (8B)**, model id `@cf/meta/llama-guard-3-8b` (`wrangler.toml:66`, referenced via `env.GUARD_MODEL`, `src/env.ts:19`). `llamaGuard()` (`src/chaperone/guard.ts:18-50`) runs the cleaned text through `runGuarded` (the metered AI gateway, tier `"t1"`), then parses the Llama-Guard convention: a first line of `safe`, or `unsafe\nS<category>` (`guard.ts:37-44`).

**Fail-closed by construction** (`src/chaperone/guard.ts:1-5,42-49`):

- Output contains `"unsafe"` → `{ safe: false, category: "S<n>" }`.
- Output contains `"safe"` → `{ safe: true }`.
- **Unparseable** output → `{ safe: false, category: "unparseable" }`.
- **Any thrown error** (model down, budget exceeded, network/timeout) → caught, sent to `captureError`, and returns `{ safe: false, category: "error" }` (`guard.ts:45-49`).

The orchestrator maps the guard result to a verdict (`src/chaperone/index.ts:128-156`):

| Guard result | Stage | Verdict | Reason |
|---|---|---|---|
| `category === "error"` or `"unparseable"` (classifier could not run) | any | **`hold`** | `guard_unavailable: <category>` |
| `S4` (child sexual exploitation) | any | **`deny`** (always) + `flagChildSafety("guard_S4")` | `child_safety: S4 … denied` |
| `S12` (sexual content) | **`chat_input`** only | **`allow`** | `s12 sexual-preference permitted (dating domain, chat_input)` |
| `S12` | any stage **other than** `chat_input` | **`deny`** | `guard_unsafe: S12` |
| Any other confirmed-unsafe category | any | **`deny`** | `guard_unsafe: <category>` |

**Fail-closed distinction (`src/chaperone/index.ts:145-147`):** an *unavailable* classifier (`error`/`unparseable`) yields the recoverable **`hold`**; a *confirmed-unsafe* result yields **`deny`**. `S4` is **always** a hard `deny`, never the recoverable hold, even if the signal is otherwise ambiguous.

#### The S12-on-`chat_input` carve-out

This is the single category-level policy exception (`src/chaperone/index.ts:136-144`). Llama-Guard flags **all** sexual content as `S12`, but a human stating a romantic/sexual *preference* to the coach ("I'm vanilla", "looking for a woman") is the on-topic use of the **private** Talk input, not a violation. So a **lone `S12`** is permitted **only** when `a.stage === "chat_input"`. The carve-out is deliberately narrow:

- `S4` (child) and every non-`S12` category still block, even on `chat_input`.
- `chat_output` and **all** publish/courtship stages are unaffected — `S12` still blocks there, so the public boards stay non-explicit by construction and Ishtar stays non-explicit in what she emits (`src/chaperone/index.ts:138-140`; the `featured.ts` route notes "no S12 carve-out, so an explicit post never reaches checkout", `src/routes/featured.ts:6`).

The code comment additionally references `S3` (sex-crimes) as still-blocking, but only `S4` and `S12` have explicit branch logic; every other category (including `S3`) falls through to the generic `deny` (`src/chaperone/index.ts:147-152`).

---

### Gate 4 — gpt-oss-safeguard policy leg (scaffold, OFF by default)

An optional policy-**conditioned** classifier leg (`src/chaperone/safeguard.ts`). It runs **only** when `SAFEGUARD_ENABLED === "1"` **and** `SAFEGUARD_MODEL` is set (`safeguardEnabled()`, `safeguard.ts:20-22`; gated in the orchestrator at `index.ts:160`). It is disabled in production: as of 2026-06-25 gpt-oss-safeguard is not available on Cloudflare Workers AI (`ai/run` → HTTP 400), so the config leaves `SAFEGUARD_MODEL`/`SAFEGUARD_ENABLED` commented out (`wrangler.toml:68-70`; rationale `safeguard.ts:1-12`).

When enabled, it hands the model **Ishtar's own policy** (`SAFEGUARD_POLICY`) as a system message and the text as a user message (`safeguard.ts:37-44`). It is fail-closed exactly like `guard.ts`: `verdict: violation` / `violat|disallow|unsafe` → unsafe with a parsed `category=…`; explicit safe verdict → safe; anything else, or a thrown error, → unsafe (`safeguard.ts:46-56`). In the orchestrator, an `error`/`unparseable` safeguard result → `hold`, any other violation → `deny` (`index.ts:162-167`).

`SAFEGUARD_POLICY` (`src/safety/safeguard-policy.ts:9-21`) is a venue-specific taxonomy the model reasons over, with categories: `minor` (hard block), `crisis` (route to care — handled upstream), `coercion`, `stalking`, `sexual_explicit`, `harassment_hate`, `injection`, `privacy`. It explicitly declares ordinary dating talk / debriefs / heartbreak safe even when "blunt, sad, or frustrated". The crisis line is present only so the classifier never *contradicts* the deterministic crisis layer, which is authoritative and runs first (`safeguard-policy.ts:5-7`).

---

## 2. Deterministic safety short-circuits (`src/safety/`)

These are **not** part of the chaperone pipeline; they run earlier, on the chat routes, and are vendor-agnostic (independent of Llama-Guard).

### Crisis / self-harm layer (`crisis.ts`)

`detectCrisis(text)` (`src/safety/crisis.ts:53-60`) is a pure, deterministic, **recall-biased** detector. `STRONG` markers fire alone (e.g. `kill(ing) myself`, `want to die` with benign-hyperbole exclusions, `suicid`, `self-harm`, `can't go on`, `src/safety/crisis.ts:20-34`); `WEAK` markers need ≥2 co-occurring so ordinary dating frustration doesn't cry wolf (`crisis.ts:36-44,57-58`). Rationale: a HeartBench finding (2026-06-25) showed the coach model coached *through* a suicidal-ideation message with dating advice (safety 0.0), and the generic classifier either missed oblique phrasing or cold-blocked it (`crisis.ts:1-15`).

On a hit the route returns `crisisResponse(country)` (`crisis.ts:82-96`) — warm, human-reviewed copy that localizes a crisis line by Cloudflare `cf-ipcountry`, with a small hardcoded set of famous national lines (US/CA 988, GB/IE Samaritans 116 123, AU 13 11 14, NZ 1737, `crisis.ts:67-74`) and a `findahelpline.com/countries/<cc>` fallback for every other country. `recordCrisisEvent` logs only the detection signal + caller, **never** the verbatim message (`crisis.ts:98-111`).

### Minor / age-gate layer (`age.ts`)

`detectMinor(text)` (`src/safety/age.ts:26-29`) deterministically detects a **self-disclosed** under-18 age via the `MINOR` regexes (`age.ts:15-23`): "I'm 16 (years old)", bare "I'm 1[0-7]" only in a clear age context (excludes "I'm 16 minutes away"), "I'm a minor/underage/under 18", and "I'm in high/middle school / 6–11th grade". On a hit the route returns `MINOR_REDIRECT` — a kind, non-coaching "adults-only (18+)" redirect (`age.ts:32-36`) and `recordMinorEvent` flags the operator (`age.ts:39-45`). The code is explicit that this catches *disclosed* age only; the binding age check is **human-side Didit identity verification** before any real-world meeting, not this layer (`age.ts:9-11`).

---

## 3. Where the chaperone runs in the request flow

Call sites (each named with its stage):

| Route / module | File:line | Stage | Notes |
|---|---|---|---|
| Persona admission | `src/admission.ts:87` | `admission` | Rejects the persona on any non-`allow` verdict (`admission.ts:99-107`). |
| Match coordinator | `src/match/coordinator.ts:280` | (courtship turn) | Gates courtship turns. |
| Live match stream | `src/match/stream.ts:265` | `pre_turn` | `callerRef:"stream"`. |
| Tryst room | `src/routes/tryst.ts:43` | `pre_turn` | Gates room messages. |
| **Talk chat — free/session** | `src/routes/chat.ts:287` (input), `:363` (output) | `chat_input` / `chat_output` | See flow below. |
| **Talk chat — x402 paid** | `src/routes/chat.ts:475` (input), `:490` (output) | `chat_input` / `chat_output` | `callerRef:"x402:<payer>"`. |
| Talk feedback | `src/routes/chat.ts:561` | `chat_input` | |
| Chat→floor dating-doc | `src/routes/chat.ts:650` | `admission` | Screens the composed heart doc. |
| Premium report | `src/premium/report-generate.ts:77` | (report) | |
| Featured board (agent) | `src/routes/featured.ts:169` | `pre_publish` | Screens summary+reveal+`authorRef` (SEC F1). |
| Featured board (human checkout) | `src/routes/featured.ts:317` | `pre_publish` | Releases the slot if blocked. |

### The Talk chat turn (representative full flow)

In `src/routes/chat.ts` the order for one coaching turn is (`chat.ts:247-370`):

1. **18+ re-attestation** gate (403 if not confirmed, `chat.ts:238-240`).
2. **(a0) Crisis short-circuit** — `detectCrisis`; on hit returns vetted care copy, `via:"crisis"`, **free**, and is *not* captured as a coaching episode (`chat.ts:250-259`).
3. **(a0b) Minor short-circuit** — `detectMinor`; on hit returns `MINOR_REDIRECT`, `via:"age_gate"`, no charge, no stored history (`chat.ts:264-267`).
4. **(a0c) Pre-launch** whitelist gate and **(a0d) intent gate** (off-topic; this one is fail-*open*, being a scope gate not a safety gate, `chat.ts:271-284`).
5. **(a) Chaperone the input** at `chat_input` **before charging** — a blocked message costs nothing; anything not `allow`/`sanitize` → **422** "message held by the chaperone" (`chat.ts:286-289`).
6. Charge a credit, then generate the reply (`chat.ts:313-333`).
7. **(d) Output defenses**, all fail-closed and independent (`chat.ts:355-370`): (1) `egressFilter` deterministic secret-shape scrub, (2) `looksLikeSystemLeak` prompt-echo backstop, (3) **chaperone at `chat_output`**. The reply is only served if egress is clean **and** not a system leak **and** the output verdict is `allow`/`sanitize`; otherwise it is withheld (`chat.ts:364-370`).

Note the asymmetry the carve-out creates: the human's input at step 5 (`chat_input`) permits a lone `S12`; Ishtar's reply at step 7 (`chat_output`) does not — so she can *hear* a sexual preference but will not *emit* explicit content.
