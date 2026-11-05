CREATE TABLE `payroll_adjustments` (
	`id` text PRIMARY KEY NOT NULL,
	`week_start` text NOT NULL,
	`staff_id` text NOT NULL,
	`label` text NOT NULL,
	`amount` integer NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payroll_adjustments_week_staff_idx` ON `payroll_adjustments` (`week_start`,`staff_id`);--> statement-breakpoint
ALTER TABLE `staff` ADD `ca_repayment` integer DEFAULT 50000 NOT NULL;--> statement-breakpoint
-- Cebu's daily minimum wage, what a Reliever earns for a Relief Shift. Editable in Settings.
INSERT INTO `pay_rules` (`key`, `value_json`, `updated_at`) VALUES ('minimum_wage_daily', '58200', '2026-11-05T00:00:00.000Z');
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0018_pay_breakdown' WHERE `key` = 'schema_version';
