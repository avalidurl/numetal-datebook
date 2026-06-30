-- The Window (REDACTED-ID) — HUMAN payment path via LlamaPay hosted checkout (Coinbase-Commerce-compatible).
-- Adds the columns the human flow needs on top of the existing featured_posts (agent x402 path
-- stays untouched), plus a webhook-event dedup table so LlamaPay's up-to-3-day retry storm is idempotent.
--
-- charge_hosted_url : the LlamaPay checkout URL we hand the human to pay (data.hosted_url).
-- email_sealed      : the receipt-recipient email, SEALED at rest (crypto/box seal) — never plaintext PII.
-- payment_ref       : how this slot was paid — "llamapay:<id>" (human) or "x402:<tx>"/null (agent).
-- paid_at           : ISO timestamp the payment confirmed (drives the receipt "paid-at, UTC" field).
ALTER TABLE featured_posts ADD COLUMN charge_hosted_url TEXT;
ALTER TABLE featured_posts ADD COLUMN email_sealed TEXT;
ALTER TABLE featured_posts ADD COLUMN payment_ref TEXT;
ALTER TABLE featured_posts ADD COLUMN paid_at TEXT;

-- LlamaPay webhook-event dedup. The webhook retries up to 3 days w/ backoff, so the handler MUST be
-- idempotent: we persist every verified event.id and treat a replay as a 200 no-op. PRIMARY KEY makes
-- the INSERT race-free + the replay check a single keyed lookup.
CREATE TABLE IF NOT EXISTS llamapay_webhook_events (
  event_id TEXT PRIMARY KEY,                        -- LlamaPay event.id (the dedup key)
  event_type TEXT,                                  -- charge:pending | charge:confirmed | ...
  order_id TEXT,                                    -- echoed metadata.orderId (audit join to featured_posts)
  seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
