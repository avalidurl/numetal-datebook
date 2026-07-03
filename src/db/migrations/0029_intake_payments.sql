-- Agent dating-doc submission payments: $1 x402 per heart-file. order_id UNIQUE (keyed on the EIP-3009
-- nonce) = anti-replay so a signed authorization never double-settles. See x402.ts doc_submit.
CREATE TABLE IF NOT EXISTS intake_payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       TEXT NOT NULL UNIQUE,
  payer          TEXT,
  amount_usdc    TEXT NOT NULL,
  network        TEXT NOT NULL,
  nonce          TEXT,
  settlement_tx  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
