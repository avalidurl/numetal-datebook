-- MPP dual-rail: a settled Tempo tx is single-use across ALL challenges/refs. In push mode the
-- client submits a PUBLIC on-chain tx hash, so order_id (per-challenge) and (network,nonce) are
-- both fresh per redemption attempt and cannot catch one tx replayed under many fresh challenges.
-- A partial UNIQUE index on settlement_tx makes the ledger INSERT the atomic admission gate:
-- the second redemption of the same tx loses the insert (conflict) and is refused — closing the
-- concurrent N-spend race that a check-then-insert SELECT cannot. Partial (WHERE NOT NULL) so it
-- never constrains the historical rows that predate settlement recording.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_topups_settlement_tx
  ON chat_topups (settlement_tx)
  WHERE settlement_tx IS NOT NULL;
