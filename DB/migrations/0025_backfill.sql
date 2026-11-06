CREATE TABLE `daily_summaries` (
	`date` text PRIMARY KEY NOT NULL,
	`cash` integer DEFAULT 0 NOT NULL,
	`gcash` integer DEFAULT 0 NOT NULL,
	`oil` integer DEFAULT 0 NOT NULL,
	`voucher` integer DEFAULT 0 NOT NULL,
	`foc` integer DEFAULT 0 NOT NULL,
	`commission` integer DEFAULT 0 NOT NULL,
	`guests` integer DEFAULT 0 NOT NULL,
	`therapists` integer DEFAULT 0 NOT NULL,
	`rejects` integer DEFAULT 0 NOT NULL,
	`laundry` integer DEFAULT 0 NOT NULL,
	`expenses` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `past_months` (
	`month` text PRIMARY KEY NOT NULL,
	`receptionist_pay` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `past_payslips` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`week_start` text NOT NULL,
	`week_end` text NOT NULL,
	`paid_on` text,
	`daily_rate` integer NOT NULL,
	`days_worked` integer NOT NULL,
	`basic` integer NOT NULL,
	`overtime_hours` integer NOT NULL,
	`overtime_pay` integer NOT NULL,
	`premium_pay` integer NOT NULL,
	`late_undertime` integer NOT NULL,
	`sss` integer NOT NULL,
	`hdmf` integer NOT NULL,
	`phic` integer NOT NULL,
	`ca_repayment` integer NOT NULL,
	`gross` integer NOT NULL,
	`net` integer NOT NULL,
	`ca_balance` integer,
	`days_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `past_payslips_staff_week_idx` ON `past_payslips` (`staff_id`,`week_start`);--> statement-breakpoint
CREATE INDEX `past_payslips_staff_idx` ON `past_payslips` (`staff_id`);--> statement-breakpoint
CREATE TABLE `past_therapist_weeks` (
	`id` text PRIMARY KEY NOT NULL,
	`week_start` text NOT NULL,
	`staff_id` text NOT NULL,
	`gross` integer NOT NULL,
	`days_worked` integer NOT NULL,
	`net` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `past_therapist_weeks_week_staff_idx` ON `past_therapist_weeks` (`week_start`,`staff_id`);--> statement-breakpoint
ALTER TABLE `expenses` ADD `backfill_month` text;--> statement-breakpoint
ALTER TABLE `royalty_statements` ADD `fixed` integer DEFAULT false NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `expense_categories` (`id`, `name`, `sort_order`) VALUES
  ('maintenance', 'Maintenance', 105),
  ('government', 'Government contributions (shop share)', 107);
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0025_backfill' WHERE `key` = 'schema_version';
