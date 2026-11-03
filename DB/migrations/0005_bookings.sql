CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`business_day` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`guest_name` text,
	`guest_phone` text,
	`service_id` text NOT NULL,
	`duration_min` integer NOT NULL,
	`scheduled_at` text,
	`requested_therapist_id` text,
	`therapist_id` text,
	`room_id` integer,
	`flex_mode` text,
	`portable_table` integer DEFAULT false NOT NULL,
	`override_reason` text,
	`notes` text,
	`started_at` text,
	`done_at` text,
	`cancel_reason` text,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_therapist_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`therapist_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bookings_day_idx` ON `bookings` (`business_day`,`status`);--> statement-breakpoint
CREATE INDEX `bookings_therapist_idx` ON `bookings` (`therapist_id`,`status`);--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0005_bookings' WHERE `key` = 'schema_version';
