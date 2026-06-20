CREATE TABLE `escalation_invites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`couple_id` integer NOT NULL,
	`owner_id` integer NOT NULL,
	`token` text NOT NULL,
	`status` text DEFAULT 'sent' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`claimed_at` text,
	`expires_at` text,
	FOREIGN KEY (`couple_id`) REFERENCES `couples`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `escalation_invites_token_unique` ON `escalation_invites` (`token`);--> statement-breakpoint
CREATE INDEX `idx_escalation_invites_couple` ON `escalation_invites` (`couple_id`,`status`);--> statement-breakpoint
CREATE TABLE `identity_verifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer NOT NULL,
	`provider` text DEFAULT 'didit' NOT NULL,
	`session_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`age_over_18` integer DEFAULT 0 NOT NULL,
	`country` text,
	`expires_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_identity_verifications_owner` ON `identity_verifications` (`owner_id`,`status`);