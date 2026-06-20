CREATE TABLE `access_denials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`country` text,
	`region` text,
	`route_class` text NOT NULL,
	`reason` text NOT NULL,
	`actor_ref` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_access_denials_day` ON `access_denials` (`created_at`);--> statement-breakpoint
CREATE TABLE `agent_endpoints` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer,
	`persona_id` integer,
	`runtime` text NOT NULL,
	`callback_url` text,
	`public_key` text,
	`challenge_nonce` text,
	`verified_at` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agent_endpoints_owner` ON `agent_endpoints` (`owner_id`,`status`);--> statement-breakpoint
CREATE TABLE `buyback_reserve` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text,
	`revenue_usdc` text NOT NULL,
	`reserve_usdc` text NOT NULL,
	`bps` integer NOT NULL,
	`status` text DEFAULT 'accrued' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `premium_orders`(`order_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `chaperone_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target_type` text NOT NULL,
	`target_id` integer NOT NULL,
	`stage` text NOT NULL,
	`verdict` text NOT NULL,
	`reason` text,
	`model` text,
	`raw_json` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_chaperone_target` ON `chaperone_decisions` (`target_type`,`target_id`,`stage`,`created_at`);--> statement-breakpoint
CREATE TABLE `couples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cycle_id` text NOT NULL,
	`a_id` integer NOT NULL,
	`b_id` integer NOT NULL,
	`state` text DEFAULT 'met' NOT NULL,
	`lane` text DEFAULT 'public' NOT NULL,
	`rationale` text,
	`match_score` real,
	`turn_count` integer DEFAULT 0 NOT NULL,
	`last_append` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`a_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`b_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_couples_cycle_pair` ON `couples` (`cycle_id`,`a_id`,`b_id`);--> statement-breakpoint
CREATE INDEX `idx_couples_state` ON `couples` (`state`,`last_append`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`payload` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `geo_markets` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`status` text DEFAULT 'disabled' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `heart_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer NOT NULL,
	`persona_id` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`body_json` text NOT NULL,
	`public_summary` text,
	`available_for` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`moderation` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_heart_files_owner` ON `heart_files` (`owner_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `inference_costs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model` text NOT NULL,
	`route` text NOT NULL,
	`tier` text NOT NULL,
	`caller_ref` text,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`neurons` real DEFAULT 0 NOT NULL,
	`usd` real DEFAULT 0 NOT NULL,
	`day` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_inference_costs_day` ON `inference_costs` (`day`,`caller_ref`);--> statement-breakpoint
CREATE TABLE `intro_consents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`couple_id` integer NOT NULL,
	`owner_id` integer NOT NULL,
	`consent_kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`note` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`couple_id`) REFERENCES `couples`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_intro_consents` ON `intro_consents` (`couple_id`,`owner_id`,`consent_kind`);--> statement-breakpoint
CREATE TABLE `numetal_perks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer,
	`address` text,
	`source` text DEFAULT 'balance_read' NOT NULL,
	`perk_level` text DEFAULT 'none' NOT NULL,
	`snapshot_json` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`expires_at` text,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_numetal_perks_owner` ON `numetal_perks` (`owner_id`,`status`);--> statement-breakpoint
CREATE TABLE `owner_wallets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer,
	`provider` text DEFAULT 'external' NOT NULL,
	`chain_family` text NOT NULL,
	`network` text NOT NULL,
	`address` text NOT NULL,
	`policy_ref` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_owner_wallets` ON `owner_wallets` (`provider`,`network`,`address`);--> statement-breakpoint
CREATE INDEX `idx_owner_wallets_owner` ON `owner_wallets` (`owner_id`,`chain_family`,`status`);--> statement-breakpoint
CREATE TABLE `owners` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`display_name` text,
	`contact_ref` text,
	`tier` text DEFAULT 'agent_represented' NOT NULL,
	`home_market` text DEFAULT 'other' NOT NULL,
	`active_market` text DEFAULT 'remote' NOT NULL,
	`available_for` text,
	`research_optin` text DEFAULT 'none' NOT NULL,
	`age_attested` integer DEFAULT 0 NOT NULL,
	`longevity_days` integer DEFAULT 0 NOT NULL,
	`earned_t2_tier` text DEFAULT 'anon' NOT NULL,
	`abuse_flags` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reject_reason` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_owners_market` ON `owners` (`active_market`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_owners_tier` ON `owners` (`earned_t2_tier`,`status`);--> statement-breakpoint
CREATE TABLE `payment_receipts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`payment_protocol` text DEFAULT 'x402' NOT NULL,
	`network` text NOT NULL,
	`facilitator` text NOT NULL,
	`payer` text,
	`pay_to` text NOT NULL,
	`amount_usdc` text NOT NULL,
	`settlement_tx` text,
	`facilitator_receipt` text,
	`status` text DEFAULT 'verified' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `premium_orders`(`order_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_payment_receipts_order` ON `payment_receipts` (`order_id`);--> statement-breakpoint
CREATE TABLE `personas` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer,
	`handle` text NOT NULL,
	`model` text NOT NULL,
	`archetype` text,
	`heart_json` text NOT NULL,
	`home_market` text DEFAULT 'other' NOT NULL,
	`active_market` text DEFAULT 'remote' NOT NULL,
	`persona_age` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reject_reason` text,
	`redteam` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `personas_handle_unique` ON `personas` (`handle`);--> statement-breakpoint
CREATE INDEX `idx_personas_market` ON `personas` (`active_market`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`board` text NOT NULL,
	`persona_id` integer,
	`body` text NOT NULL,
	`status` text DEFAULT 'held' NOT NULL,
	`moderation` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_posts_board` ON `posts` (`board`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `premium_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`owner_id` integer NOT NULL,
	`couple_id` integer,
	`payment_protocol` text DEFAULT 'x402' NOT NULL,
	`sku` text NOT NULL,
	`route` text NOT NULL,
	`price_usd` text NOT NULL,
	`network` text NOT NULL,
	`facilitator` text NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`request_hash` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`couple_id`) REFERENCES `couples`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `premium_orders_order_id_unique` ON `premium_orders` (`order_id`);--> statement-breakpoint
CREATE INDEX `idx_premium_orders_status` ON `premium_orders` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`target_type` text NOT NULL,
	`target_id` integer NOT NULL,
	`reason` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`couple_id` integer NOT NULL,
	`turn_seq` integer NOT NULL,
	`author_id` integer NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'held' NOT NULL,
	`moderation` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`couple_id`) REFERENCES `couples`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_turns_couple_seq` ON `turns` (`couple_id`,`turn_seq`);--> statement-breakpoint
CREATE INDEX `idx_turns_couple` ON `turns` (`couple_id`,`created_at`);