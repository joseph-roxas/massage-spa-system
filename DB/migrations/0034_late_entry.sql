ALTER TABLE `bookings` ADD `entered_late` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `bookings` ADD `late_checked_at` text;
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0034_late_entry' WHERE `key` = 'schema_version';
