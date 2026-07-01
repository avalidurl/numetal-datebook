# HTTP fuzzing — schemathesis vs `wrangler dev`

Phase 2/3 of the fuzzing plan (`fuzz/README.md` → "Next"): black-box HTTP fuzzing of the
live Worker, driven by a hand-authored OpenAPI 3.1 spec (there is no server-emitted schema).

```
./fuzz/http/run-schemathesis.sh [max-examples]   # default 40
```

The script:
1. Shelves `~/.pnp.cjs` and unsets `NODE_OPTIONS` (both break wrangler's esbuild bundling);
   restores on exit via a trap.
2. `wrangler d1 migrations apply datebook-staging --local` — seeds the local D1 so public
   reads exercise real handlers instead of throwing `no such table` (see caveat below).
3. Starts `wrangler dev --port 8787 --local` in the background, waits for `GET /health`.
4. `schemathesis run --checks all --url http://127.0.0.1:8787 fuzz/http/openapi.yaml
   --max-examples 40`.
5. Tears down wrangler + workerd and restores the pnp shelf.

schemathesis 4.x renamed `--base-url` → `--url`; the script auto-detects and uses whichever
the installed CLI supports. Install: `pipx install schemathesis` (4.22.1 verified here).

## Spec = `openapi.yaml`

Request shapes transcribed from the zod schemas in `src/routes/*`. It covers the key public
+ representative endpoints and declares the wide status set the Worker legitimately returns
under dev (403 when `ACCESS_KEY` unset, 503 when `PAY_TO`/LlamaPay unset) so the fuzzer only
flags TRUE server errors. `POST /api/onboard` is documented as NOT MOUNTED — the real
onboarding handler is `POST /api/intake/heart-file`, which is included and access-gated.

## Dev-environment caveats (read before trusting a report)

- **Empty local D1 → 500.** A fresh `wrangler dev --local` has no tables; public reads
  (`/api/featured`, `/api/public/*`) then throw `D1_ERROR: no such table` → 500. That is an
  ENVIRONMENT artifact, not a code bug. Step 2 above applies the migrations so those reads
  return 200. If you run `wrangler dev` by hand, run the migrate command first.
- **`ACCESS_KEY` unset → 403** on every access-gated route (intake, premium, admin). The gate
  is working; there is nothing to authenticate against in dev.
- **`PAY_TO` / LlamaPay secrets unset → 503** on the money paths. Fail-closed by design.

## Triage of the current run (13 findings — none are server bugs)

- **`Server error` 503 ×2** (`llamapay-webhook`, `featured/reserve`): LlamaPay unconfigured in
  dev → deliberate 503. Verified fail-closed: a forged webhook signature returns 401 once
  `LLAMAPAY_WEBHOOK_SECRET` is set (`src/payments/llamapay.ts` constant-time compare).
- **`Missing header not rejected` 403-vs-401 ×2** (`intake/heart-file`, `compatibility-report`):
  the access gate returns 403 ("locked") where schemathesis expects 401. Convention nit, not a
  bypass — verified no/bogus/empty Bearer all → 403, no auth bypass.
- **`Unsupported methods` TRACE-vs-405 ×6**: the access gate 403s TRACE instead of 405. Denying
  TRACE is fine; a 405 would be tidier but is not a defect.
- **`API rejected schema-compliant request` 400 ×2** (`chat/session`, `chat/topup`): business
  rules the spec can't express (SIWE message must reference the venue domain; `over18` must be
  `true`). Spec-shape mismatch, not a server fault.

**No 500s, no auth bypass** once the DB is seeded. A future run that surfaces a 500 on a seeded
DB, or a 2xx on an access-gated route with no credential, is a real FINDING.
