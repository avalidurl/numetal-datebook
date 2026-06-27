-- Persist the delivered compatibility report so it is re-fetchable + a durable record of what was sent
-- (premium.ts previously returned the artifact and stored it nowhere).
ALTER TABLE premium_orders ADD COLUMN report_text TEXT;
