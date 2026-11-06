CREATE TABLE `branding` (
	`id` integer PRIMARY KEY NOT NULL,
	`business_name` text,
	`logo` text,
	`updated_at` text NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `rejects` (
	`id` text PRIMARY KEY NOT NULL,
	`business_day` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rejects_day_idx` ON `rejects` (`business_day`);--> statement-breakpoint
ALTER TABLE `vouchers` ADD `used_before_on` text;--> statement-breakpoint
ALTER TABLE `vouchers` ADD `used_before_note` text;--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0024_front_desk_vouchers_branding' WHERE `key` = 'schema_version';
