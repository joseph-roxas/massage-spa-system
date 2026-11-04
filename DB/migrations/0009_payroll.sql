CREATE TABLE `bonuses` (
	`id` text PRIMARY KEY NOT NULL,
	`year` integer NOT NULL,
	`staff_id` text NOT NULL,
	`kind` text NOT NULL,
	`basis` integer NOT NULL,
	`bp` integer,
	`amount` integer NOT NULL,
	`paid_at` text,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bonuses_year_staff_kind_idx` ON `bonuses` (`year`,`staff_id`,`kind`);--> statement-breakpoint
CREATE TABLE `ca_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`entry` text NOT NULL,
	`amount` integer NOT NULL,
	`cash_advance_id` text,
	`payroll_id` text,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cash_advance_id`) REFERENCES `cash_advances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payroll_id`) REFERENCES `payrolls`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ca_ledger_staff_idx` ON `ca_ledger` (`staff_id`);--> statement-breakpoint
CREATE TABLE `cash_advances` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`amount` integer NOT NULL,
	`business_day` text NOT NULL,
	`against_week_start` text,
	`cash_out_id` text,
	`override_by` text,
	`note` text,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cash_out_id`) REFERENCES `cash_outs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`override_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cash_advances_staff_idx` ON `cash_advances` (`staff_id`,`against_week_start`);--> statement-breakpoint
CREATE TABLE `payrolls` (
	`id` text PRIMARY KEY NOT NULL,
	`week_start` text NOT NULL,
	`staff_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`gross` integer NOT NULL,
	`gov_sss` integer NOT NULL,
	`gov_phic` integer NOT NULL,
	`gov_pagibig` integer NOT NULL,
	`ca_deduction` integer NOT NULL,
	`net` integer NOT NULL,
	`basic` integer DEFAULT 0 NOT NULL,
	`breakdown_json` text NOT NULL,
	`generated_at` text NOT NULL,
	`generated_by` text,
	`approved_at` text,
	`approved_by` text,
	`released_at` text,
	`released_by` text,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`generated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`released_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payrolls_week_staff_idx` ON `payrolls` (`week_start`,`staff_id`);--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0009_payroll' WHERE `key` = 'schema_version';
