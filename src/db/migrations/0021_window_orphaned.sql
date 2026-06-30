-- The Window (REDACTED-ID) — pre-merge review hardening for the HUMAN payment path.
--
-- Finding #3 (late/orphaned payment): a verified LlamaPay charge can arrive for an order whose
-- reservation already expired (or was purged). We must NEVER drop a paid event with no record. If the
-- board has room we re-claim a slot; if it is FULL we cannot feature it, so we persist the paid event
-- here (for refund/comp) and the row's status goes to 'orphaned'. 'orphaned' is a new featured_posts
-- status value (no schema change needed — status is a free TEXT column).
--
-- emailed (finding #7): records whether the TR-100 receipt email actually sent, surfaced in GET /status.
ALTER TABLE featured_posts ADD COLUMN emailed INTEGER NOT NULL DEFAULT 0;

-- reserver_ip (finding #6): the cf-connecting-ip that created an unpaid reservation. Used ONLY to cap
-- concurrent OUTSTANDING unpaid reservations per IP to 1 (anti-squatting). Not PII-grade contact data;
-- a coarse abuse signal cleared implicitly when the reservation goes live/expired.
ALTER TABLE featured_posts ADD COLUMN reserver_ip TEXT;
CREATE INDEX IF NOT EXISTS idx_featured_reserver_ip ON featured_posts(status, reserver_ip);

-- Paid-but-unfeatured ledger. One row per orphaned paid event so finance can refund/comp. email_sealed
-- is the sealed receipt-recipient email (never plaintext PII), copied from featured_posts at orphan time.
CREATE TABLE IF NOT EXISTS featured_orphaned_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,                            -- the server order id (featured:human:<uuid>)
  llamapay_payment_id TEXT NOT NULL,                 -- LlamaPay payment id (data.id) — the money pointer
  email_sealed TEXT,                                 -- sealed receipt email (refund contact); never plaintext
  amount TEXT,                                       -- USD amount paid ("50.00")
  received_at TEXT NOT NULL DEFAULT (datetime('now')) -- when we recorded the orphaned payment
);
-- Dedup + audit lookup: at most one orphan record per (order_id, llamapay_payment_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_orphaned_order_payment
  ON featured_orphaned_payments(order_id, llamapay_payment_id);
