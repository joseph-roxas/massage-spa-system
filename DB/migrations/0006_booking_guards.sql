CREATE UNIQUE INDEX `bookings_one_per_room` ON `bookings` (`room_id`) WHERE status = 'in_service';--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_one_per_therapist` ON `bookings` (`therapist_id`) WHERE status = 'in_service';--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0006_booking_guards' WHERE `key` = 'schema_version';
