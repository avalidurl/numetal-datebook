-- Talk-to-Ishtar (paid chat): accounts keyed by wallet, bearer sessions (hash-only), message log.
CREATE TABLE `chat_accounts` (
  `address` text PRIMARY KEY NOT NULL,
  `credits` integer DEFAULT 0 NOT NULL,
  `perk_level` text DEFAULT 'none' NOT NULL,
  `free_used_day` text,
  `free_used_count` integer DEFAULT 0 NOT NULL,
  `perk_checked_at` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chat_sessions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `token_hash` text NOT NULL,
  `address` text NOT NULL,
  `source` text DEFAULT 'signature' NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `expires_at` text NOT NULL,
  `revoked` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_sessions_token_hash_unique` ON `chat_sessions` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `idx_chat_sessions_addr` ON `chat_sessions` (`address`);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `address` text NOT NULL,
  `role` text NOT NULL,
  `body` text NOT NULL,
  `mode` text DEFAULT 'chat' NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_chat_messages_addr` ON `chat_messages` (`address`, `created_at`);
--> statement-breakpoint
CREATE TABLE `chat_topups` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `order_id` text NOT NULL,
  `payer` text,
  `amount_usdc` text NOT NULL,
  `credits` integer NOT NULL,
  `network` text NOT NULL,
  `settlement_tx` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_topups_order_id_unique` ON `chat_topups` (`order_id`);
