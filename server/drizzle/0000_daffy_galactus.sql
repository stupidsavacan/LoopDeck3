CREATE TABLE `cloud_faults` (
	`object_key` text PRIMARY KEY NOT NULL,
	`detected_at` integer NOT NULL,
	`reason` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cloud_garbage` (
	`object_key` text PRIMARY KEY NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cloud_heads` (
	`pack_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cloud_library` (
	`id` integer PRIMARY KEY NOT NULL,
	`secret_stamp` text NOT NULL,
	`epoch` integer NOT NULL,
	`seq` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cloud_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`reset_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cloud_objects` (
	`object_key` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cloud_receipts` (
	`op_id` text PRIMARY KEY NOT NULL,
	`request_fp` text NOT NULL,
	`result` text
);
--> statement-breakpoint
CREATE TABLE `cloud_revisions` (
	`pack_id` text NOT NULL,
	`revision` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`object_key` text NOT NULL,
	`title` text NOT NULL,
	`questions` integer NOT NULL,
	`committed_at` text NOT NULL,
	`op_id` text NOT NULL,
	PRIMARY KEY(`pack_id`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `cloud_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`epoch` integer NOT NULL,
	`device_name` text NOT NULL,
	`created_at` integer NOT NULL
);
