CREATE TABLE `guests` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`statutory_type` text,
	`statutory_id_no` text,
	`merged_into` text,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `guests_name_idx` ON `guests` (`name`);--> statement-breakpoint
CREATE INDEX `guests_phone_idx` ON `guests` (`phone`);--> statement-breakpoint
ALTER TABLE `bookings` ADD `guest_id` text REFERENCES guests(id);--> statement-breakpoint
CREATE INDEX `bookings_guest_idx` ON `bookings` (`guest_id`);--> statement-breakpoint
ALTER TABLE `voucher_sales` ADD `guest_id` text REFERENCES guests(id);--> statement-breakpoint
-- A Guest is a Regular after this many Visits within this many days. Editable by the Super Admin.
INSERT INTO `pay_rules` (`key`, `value_json`, `updated_at`) VALUES ('regular_guest_rule', '{"visits":3,"days":90}', '2026-11-05T00:00:00.000Z');
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0019_guest_records' WHERE `key` = 'schema_version';
