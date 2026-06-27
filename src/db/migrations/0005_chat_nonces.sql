-- Single-use server nonces for wallet sign-in (SIWE anti-replay).
CREATE TABLE `chat_nonces` (
  `nonce` text PRIMARY KEY NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `used` integer DEFAULT 0 NOT NULL
);
