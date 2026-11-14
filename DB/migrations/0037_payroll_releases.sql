CREATE TABLE `payroll_releases` (
	`id` text PRIMARY KEY NOT NULL,
	`payroll_id` text NOT NULL,
	`amount` integer NOT NULL,
	`business_day` text NOT NULL,
	`cash_transfer_id` text,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`payroll_id`) REFERENCES `payrolls`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cash_transfer_id`) REFERENCES `cash_transfers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payroll_releases_payroll_idx` ON `payroll_releases` (`payroll_id`);
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0037_payroll_releases' WHERE `key` = 'schema_version';
