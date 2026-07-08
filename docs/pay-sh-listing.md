# pay.sh / pay-skills listing — Ishtar API

Ishtar is the **resource server** (not a proxy). Gateway URL = direct API URLs on `https://api.ishtar.numetal.xyz`.

## Architecture (no Solana private key)

- You only configure **`PAY_TO_SOLANA`** (base58 pubkey). The Worker never holds a SOL signing key.
- CDP verify/settle uses existing **`CDP_API_KEY_ID`** / **`CDP_API_KEY_SECRET`** (same as Base).
- Solana tx fees are sponsored by the facilitator **`feePayer`** from `GET …/x402/supported` (cached ~5 min).

## Production env (Ishtar Worker)

| Var | Where | Value |
|-----|-------|-------|
| `X402_MODE` | secret/var | `mainnet` |
| `X402_SOLANA_ENABLED` | var | `1` |
| `PAY_TO_SOLANA` | var | `2GvLgz2ovzNkrYEzJsZ1kRovXjVQnmm7WRWFd3vFzsma` |
| `PAY_TO` | secret | Base EVM receive address (keep existing) |
| `CDP_API_KEY_ID` | secret | existing CDP key |
| `CDP_API_KEY_SECRET` | secret | existing CDP secret |
| `PUBLIC_API_URL` | var | `https://api.ishtar.numetal.xyz` |

No `SOL_PRIVATE_KEY`, `SOLANA_KEYPAIR`, or similar.

## pay-skills PR checklist

1. Fork [solana-foundation/pay-skills](https://github.com/solana-foundation/pay-skills)
2. Create `providers/numetal/ishtar/` (FQN: `numetal/ishtar`)
3. Commit sidecar OpenAPI:

```bash
curl -fsSL https://api.ishtar.numetal.xyz/openapi.json \
  -o providers/numetal/ishtar/openapi.json
```

4. Add `providers/numetal/ishtar/PAY.md` (draft below)
5. Validate:

```bash
npx @solana/pay catalog check providers/numetal/ishtar/PAY.md -v
npx @solana/pay catalog check providers/numetal/ishtar/PAY.md --strict
```

6. Open PR — CI probes paid endpoints for HTTP 402 + Solana USDC/USDT compatibility

## Draft `PAY.md`

```markdown
---
name: ishtar
title: "Ishtar — agent-mediated dating API"
description: "Pay-per-call USDC API for AI dating coaching, dating-doc intake, chat credits, and public Window slots. x402 on Base and Solana; agents POST JSON and settle before each paid response."
use_case: "Use when an agent needs pay-per-answer relationship coaching, files a human dating doc onto Ishtar's floor, tops up chat credits, or buys a 24h public dating-doc Window slot."
category: ai_ml
service_url: https://api.ishtar.numetal.xyz
openapi:
  path: openapi.json
---

Ishtar is an adults-only, agent-mediated dating venue. Paid surfaces return **HTTP 402** with x402 v2 `accepts[]` offering **Base USDC** and **Solana USDC** (when enabled). Retry with `PAYMENT-SIGNATURE` after signing.

Primary paid endpoints (see OpenAPI):

- `POST /api/chat/ask` — $0.10 per coaching answer (discovery/catalog anchor)
- `POST /api/intake/heart-file` — $1.00 dating-doc submission
- `POST /api/chat/topup` — $2.00 chat credit block
- `POST /api/featured/post` — pay-to-be-seen Window slot (price from runtime settings)

Free reads: `GET /api/floor`, `GET /api/public/stats`, `GET /openapi.json`.

## Spend-aware usage

- Prefer `POST /api/chat/ask` for single questions instead of bulk top-ups when possible.
- Reuse client idempotency keys (`ref`) on top-up and Window POSTs.
- Adults-only: never fabricate `over18` / `ageAttested` fields.
```

## Notes

- **pay.sh** probes require Solana **mainnet** USDC/USDT in the 402 challenge; enable `X402_SOLANA_ENABLED=1` on production before listing.
- OpenAPI at `/openapi.json` is the machine-readable contract; keep it aligned with live 402 behavior.
- MPP/Tempo rail is optional and separate from pay.sh Solana probes.
