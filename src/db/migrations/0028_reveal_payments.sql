-- Contact-reveal payments: $20 x402 unlock per side (per couple+owner). order_id UNIQUE = anti-replay;
-- (couple_id, owner_id) UNIQUE = one paid unlock per side (idempotent re-reveal). See x402.ts reveal_unlock.
CREATE TABLE IF NOT EXISTS reveal_payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       TEXT NOT NULL UNIQUE,
  couple_id      INTEGER NOT NULL,
  owner_id       INTEGER NOT NULL,
  payer          TEXT,
  amount_usdc    TEXT NOT NULL,
  network        TEXT NOT NULL,
  nonce          TEXT,
  settlement_tx  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reveal_payments_couple_owner ON reveal_payments (couple_id, owner_id);
