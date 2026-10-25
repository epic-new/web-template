CREATE TABLE `replay_rate_limit` (
	`subject_id` text NOT NULL,
	`bucket` text NOT NULL,
	`window_started_at` integer NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`subject_id`, `bucket`)
);
--> statement-breakpoint
CREATE TABLE `replay_recording` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`registration_hash` text NOT NULL,
	`registration_payload` text NOT NULL,
	`recording_id` text,
	`status` text DEFAULT 'registering' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `replay_recording_recording_id_unique` ON `replay_recording` (`recording_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `replay_recording_subject_key` ON `replay_recording` (`subject_id`,`idempotency_key`);