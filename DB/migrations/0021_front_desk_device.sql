CREATE TABLE `front_desk_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text,
	`last_used_at` text,
	`revoked_at` text,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `front_desk_devices_token_hash_unique` ON `front_desk_devices` (`token_hash`);--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0021_front_desk_device' WHERE `key` = 'schema_version';
