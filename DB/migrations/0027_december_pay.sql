CREATE TABLE `opening_basic_pay` (
	`id` text PRIMARY KEY NOT NULL,
	`year` integer NOT NULL,
	`staff_id` text NOT NULL,
	`amount` integer NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `opening_basic_pay_year_staff_idx` ON `opening_basic_pay` (`year`,`staff_id`);--> statement-breakpoint
ALTER TABLE `bonuses` ADD `deduction` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `bonuses` ADD `period_start` text;--> statement-breakpoint
ALTER TABLE `bonuses` ADD `period_end` text;
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0027_december_pay' WHERE `key` = 'schema_version';
