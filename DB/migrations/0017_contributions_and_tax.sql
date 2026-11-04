CREATE TABLE `percentage_tax_filings` (
	`quarter` text PRIMARY KEY NOT NULL,
	`gross_sales` integer NOT NULL,
	`computed` integer NOT NULL,
	`amount_paid` integer NOT NULL,
	`filed_on` text NOT NULL,
	`expense_id` text,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`expense_id`) REFERENCES `expenses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `expenses` ADD `contributions_month` text;--> statement-breakpoint
CREATE UNIQUE INDEX `expenses_contributions_idx` ON `expenses` (`contributions_month`);--> statement-breakpoint
ALTER TABLE `staff` ADD `contribution_base` integer;--> statement-breakpoint
INSERT INTO `expense_categories` (`id`, `name`, `sort_order`) VALUES ('employer-contributions', 'Employer contributions (SSS, PhilHealth, Pag-IBIG)', 55);
--> statement-breakpoint
-- SSS Circular 2024-006, PhilHealth Advisory 2025-0002, HDMF Circular 460. Editable in Settings.
INSERT INTO `pay_rules` (`key`, `value_json`, `updated_at`) VALUES ('contribution_rates', '{"sss":{"eeBp":500,"erBp":1000,"mscMin":500000,"mscMax":3500000,"mscStep":50000,"ecLow":1000,"ecHigh":3000,"ecHighFromMsc":1500000},"phic":{"bp":500,"floor":1000000,"ceiling":10000000},"pagibig":{"eeBp":200,"eeLowBp":100,"lowUpTo":150000,"erBp":200,"fundSalaryMax":1000000}}', '2026-11-04T00:00:00.000Z');
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0017_contributions_and_tax' WHERE `key` = 'schema_version';
