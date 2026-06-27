-- 0010_payment_nonce.sql — anti-replay for x402 payments (red-team C4). The EIP-3009 authorization
-- nonce is the real single-use key; the client-supplied ref / server order id is not. A UNIQUE
-- (network, nonce) makes a replayed payment a no-op regardless of a fresh ref or a different SKU.
-- Existing rows have NULL nonce; SQLite treats NULLs as distinct so they don't collide.
ALTER TABLE chat_topups ADD nonce TEXT;
ALTER TABLE payment_receipts ADD nonce TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_topups_nonce ON chat_topups(network, nonce);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_receipts_nonce ON payment_receipts(network, nonce);
