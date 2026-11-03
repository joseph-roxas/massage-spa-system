CREATE TABLE `dtr` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`business_day` text NOT NULL,
	`clock_in` text NOT NULL,
	`clock_out` text,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	`corrected_by` text,
	`corrected_at` text,
	`correction_reason` text,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `dtr_day_idx` ON `dtr` (`business_day`);--> statement-breakpoint
CREATE INDEX `dtr_staff_idx` ON `dtr` (`staff_id`,`clock_in`);--> statement-breakpoint
ALTER TABLE `staff` ADD `pin_failed_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `staff` ADD `pin_locked_until` text;--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0004_dtr' WHERE `key` = 'schema_version';
