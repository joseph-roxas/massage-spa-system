ALTER TABLE `bookings` ADD `parent_booking_id` text;--> statement-breakpoint
CREATE INDEX `bookings_parent_idx` ON `bookings` (`parent_booking_id`);--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0020_added_services' WHERE `key` = 'schema_version';
