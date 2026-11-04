CREATE TABLE `certificates` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`type` text NOT NULL,
	`number` text,
	`issued_on` text,
	`expires_on` text,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `staff` ADD `middle_name` text;--> statement-breakpoint
ALTER TABLE `staff` ADD `gender` text;--> statement-breakpoint
ALTER TABLE `staff` ADD `birthdate` text;--> statement-breakpoint
ALTER TABLE `staff` ADD `birthplace` text;--> statement-breakpoint
ALTER TABLE `staff` ADD `civil_status` text;--> statement-breakpoint
ALTER TABLE `staff` ADD `religion` text;--> statement-breakpoint
ALTER TABLE `staff` ADD `address` text;--> statement-breakpoint
ALTER TABLE `staff` ADD `email` text;--> statement-breakpoint
ALTER TABLE `staff` ADD `sss_no` text;--> statement-breakpoint
ALTER TABLE `staff` ADD `phic_no` text;--> statement-breakpoint
ALTER TABLE `staff` ADD `tin` text;--> statement-breakpoint
ALTER TABLE `staff` ADD `pagibig_no` text;--> statement-breakpoint
ALTER TABLE `staff` ADD `hire_date` text;--> statement-breakpoint
ALTER TABLE `staff` ADD `qualification` text;--> statement-breakpoint
-- An LMT is by definition DOH-licensed.
UPDATE `staff` SET `qualification` = 'doh' WHERE `therapist_class` = 'lmt';
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0016_staff_records' WHERE `key` = 'schema_version';
