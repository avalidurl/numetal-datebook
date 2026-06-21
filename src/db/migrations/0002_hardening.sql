ALTER TABLE `turns` ADD `author_kind` text DEFAULT 'persona' NOT NULL;--> statement-breakpoint
ALTER TABLE `escalation_invites` ADD `claimed_by` text;--> statement-breakpoint
ALTER TABLE `owners` ADD `erased_at` text;