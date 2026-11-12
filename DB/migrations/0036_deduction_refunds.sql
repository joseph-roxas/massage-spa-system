CREATE TABLE `deduction_refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`week_start` text NOT NULL,
	`sss` integer NOT NULL,
	`phic` integer NOT NULL,
	`pagibig` integer NOT NULL,
	`applied` integer NOT NULL,
	`cash` integer NOT NULL,
	`adjustment_id` text,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`adjustment_id`) REFERENCES `payroll_adjustments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deduction_refunds_staff_id_unique` ON `deduction_refunds` (`staff_id`);
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0036_deduction_refunds' WHERE `key` = 'schema_version';
