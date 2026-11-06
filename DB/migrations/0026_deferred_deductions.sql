CREATE TABLE `deduction_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`entry` text NOT NULL,
	`amount` integer NOT NULL,
	`payroll_id` text,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payroll_id`) REFERENCES `payrolls`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deduction_ledger_staff_idx` ON `deduction_ledger` (`staff_id`);--> statement-breakpoint
CREATE INDEX `deduction_ledger_payroll_idx` ON `deduction_ledger` (`payroll_id`);--> statement-breakpoint
ALTER TABLE `payrolls` ADD `gov_deferred` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payrolls` ADD `gov_collected` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payrolls` ADD `gov_balance_before` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payrolls` ADD `gov_override` integer;--> statement-breakpoint
ALTER TABLE `payrolls` ADD `commission_before` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `staff` ADD `not_enrolled` integer DEFAULT false NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `pay_rules` (`key`, `value_json`, `updated_at`) VALUES ('take_home_floor', '100000', '2026-11-06T00:00:00.000Z'), ('go_live_date', '"2026-11-08"', '2026-11-06T00:00:00.000Z');
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0026_deferred_deductions' WHERE `key` = 'schema_version';
