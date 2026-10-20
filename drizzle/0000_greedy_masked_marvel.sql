CREATE TABLE `media_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`object_key` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`state` text DEFAULT 'reserved' NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `media_owner_state` ON `media_assets` (`owner`,`state`);--> statement-breakpoint
CREATE INDEX `media_expiry_state` ON `media_assets` (`expires_at`,`state`);--> statement-breakpoint
CREATE TABLE `retention_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`ran_at` integer NOT NULL,
	`removed` integer NOT NULL,
	`failed` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `review_workspaces` (
	`owner` text PRIMARY KEY NOT NULL,
	`state_json` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
