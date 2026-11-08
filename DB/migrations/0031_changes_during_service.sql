CREATE TABLE `booking_top_ups` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`minutes` integer NOT NULL,
	`price` integer NOT NULL,
	`part` text,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `booking_top_ups_booking_idx` ON `booking_top_ups` (`booking_id`);--> statement-breakpoint
CREATE TABLE `therapist_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`from_therapist_id` text NOT NULL,
	`to_therapist_id` text NOT NULL,
	`minutes_served` integer NOT NULL,
	`reason` text NOT NULL,
	`changed_at` text NOT NULL,
	`changed_by` text,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_therapist_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_therapist_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `therapist_changes_booking_idx` ON `therapist_changes` (`booking_id`);--> statement-breakpoint
ALTER TABLE `sales` ADD `top_ups_total` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- The 30-minute head massage a 1.5-hour Service can be topped up with. Priced in Settings; not sold by itself.
INSERT INTO `services` (`id`, `code`, `name`, `duration_min`, `kind`, `is_foot_type`, `voucher_eligible`, `active`, `sort_order`, `created_at`) VALUES
  ('head-30', 'HM30', 'Head Massage', 30, 'single', 1, 0, 0, 25, '2026-11-08T00:00:00.000Z');
--> statement-breakpoint
INSERT INTO `service_prices` (`id`, `service_id`, `regular_price`, `effective_from`, `created_at`) VALUES
  ('p-head-30', 'head-30', 25000, '2026-01-01', '2026-11-08T00:00:00.000Z');
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0031_changes_during_service' WHERE `key` = 'schema_version';
