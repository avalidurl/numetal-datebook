-- Talk-to-Ishtar free-allowance re-peg to USD (2026-06-25). Free messages are now sized by the USD
-- value of $NUMETAL held — floor $30, doubling every $30 — instead of raw token amounts. We cache the
-- USD value per account at each ~daily balance+price check; the quota is computed from it at read time.
ALTER TABLE chat_accounts ADD COLUMN usd_held REAL NOT NULL DEFAULT 0;
