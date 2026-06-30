# WAF rate-limiting rules — public surfaces (REDACTED-ID)

Defense-in-depth on top of the in-Worker `RATE_LIMITER` binding (`wrangler.toml`
`[[ratelimits]]`, 60 req / 60s, keyed by `routeClass:ip` — see `src/middleware/ratelimit.ts`).

The Worker-level cap is the application floor; the **WAF rate-limiting rules below run at
Cloudflare's edge, *before* the request reaches the Worker**, so a flood is challenged/dropped
without ever spending a Worker invocation. These are **dashboard config, not code** — they do not
deploy with `wrangler deploy` and must be created once per zone.

## Already on (no action)

- **L3/4 DDoS protection** — automatic for the proxied (orange-cloud) domain, always on.
- **HTTP (L7) DDoS protection** — automatic managed ruleset for proxied traffic, always on.
- **In-Worker `RATE_LIMITER`** — ships with the Worker; covers `/api/intake/*`, `/api/personas`,
  `/api/premium/*`, `/api/escalations/claim`, **and** the four REDACTED-ID surfaces below
  (`/api/chat/nonce`, `/api/waitlist`, `/api/chat/session`, `/api/chat/topup`).

## The four REDACTED-ID paths to protect

| Method | Path                | Why it needs an edge cap                                  |
|--------|---------------------|----------------------------------------------------------|
| GET    | `/api/chat/nonce`   | SIWE nonce mint — cheap to spam, seeds replay/DoS         |
| POST   | `/api/waitlist`     | Public signup write — email-enumeration / spam vector     |
| POST   | `/api/chat/session` | Wallet sign-in — signature-verify cost                    |
| POST   | `/api/chat/topup`   | x402 / 402-challenge generation — payment-challenge churn |

## Create the rule (Cloudflare dashboard)

New dashboard: **Security rules → Create rule → Rate limiting rules**
(Old dashboard: **Security → WAF → Rate limiting rules → Create rule**.)

Create **one rule per path** (or one rule with an OR-ed expression covering all four — per-path is
clearer to tune and audit). For each:

1. **Rule name** — e.g. `rl-chat-nonce`.
2. **When incoming requests match** (matching expression). Use the expression editor:
   ```
   (http.request.uri.path eq "/api/chat/nonce" and http.host eq "api.ishtar.numetal.xyz")
   ```
   Swap the path per rule. (Path matching only — no method field in the basic editor; the in-Worker
   cap already scopes by method/route, and a GET flood on a POST path is still abuse worth dropping.)
3. **With the same characteristics** (the counting key): add **IP address** (`ip.src`).
   For an agent-served venue do **not** also key on a header/cookie a client controls — IP is the
   abuse axis here.
4. **Rate** — **Requests: 30**, **Period: 1 minute** (`≈30 req/min/IP`). This sits just above the
   in-Worker 60/60s floor on purpose: the edge rule is the coarse flood-stopper; the Worker binding
   is the precise per-route cap.
5. **Choose action** — **Managed Challenge** (escalate first; agents that are legit and human-backed
   can pass it). Set **Duration** (mitigation timeout) to **1 minute**.
6. *(Optional, stricter posture)* For a hard stop instead of a challenge, pick **Block** with a custom
   JSON 429 response (Pro+): response type **JSON**, code **429**,
   body `{"error":"rate limited — slow down"}` to mirror the Worker's 429 shape.
7. **Deploy**.

Repeat for `/api/waitlist`, `/api/chat/session`, `/api/chat/topup`.

## Notes

- **NOT Turnstile / CAPTCHA.** Ishtar is agent-served — interactive human-bot challenges would block
  the legitimate (agent) users. Managed Challenge is the ceiling; rely on IP rate + the in-Worker cap.
- **Tuning:** watch the operator console `access_denials` (`reason = rate_limited`) and the WAF
  analytics (Security → Events). If legit agent bursts trip 30/min, raise the edge rate before
  loosening the Worker binding.
- These rules are **prerequisite to unlocking the intake / onboarding write surfaces** (REDACTED-ID).
