CREATE TABLE `expense_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expense_categories_name_unique` ON `expense_categories` (`name`);--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`description` text NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`recurring_expense_id` text,
	`recurring_month` text,
	`royalty_month` text,
	`created_at` text NOT NULL,
	`created_by` text,
	`confirmed_at` text,
	`confirmed_by` text,
	FOREIGN KEY (`category_id`) REFERENCES `expense_categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recurring_expense_id`) REFERENCES `recurring_expenses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`royalty_month`) REFERENCES `royalty_statements`(`month`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`confirmed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `expenses_date_idx` ON `expenses` (`date`);--> statement-breakpoint
CREATE UNIQUE INDEX `expenses_recurring_month_idx` ON `expenses` (`recurring_expense_id`,`recurring_month`);--> statement-breakpoint
CREATE UNIQUE INDEX `expenses_royalty_idx` ON `expenses` (`royalty_month`);--> statement-breakpoint
CREATE TABLE `recurring_expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`description` text NOT NULL,
	`amount` integer NOT NULL,
	`day_of_month` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`category_id`) REFERENCES `expense_categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `royalty_statements` (
	`month` text PRIMARY KEY NOT NULL,
	`month_start` text NOT NULL,
	`month_end` text NOT NULL,
	`service_sales` integer NOT NULL,
	`voucher_sales` integer NOT NULL,
	`gross_sales` integer NOT NULL,
	`bp` integer NOT NULL,
	`amount` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`computed_at` text NOT NULL,
	`confirmed_at` text,
	`confirmed_by` text,
	FOREIGN KEY (`confirmed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `stock_ins` ADD `cash_out_id` text REFERENCES cash_outs(id);--> statement-breakpoint
INSERT INTO `expense_categories` (`id`, `name`, `sort_order`) VALUES
  ('laundry',         'Laundry',                      10),
  ('petty-cash',      'Petty cash',                   20),
  ('rice-allowance',  'Rice allowance',               30),
  ('bookkeeping',     'Bookkeeping',                  40),
  ('electricity',     'Electricity',                  50),
  ('bir',             'BIR (2551Q, financial statements)', 60),
  ('business-permit', 'Business permit and requirements', 70),
  ('supplies-tools',  'Supplies and tools (linens, slippers, decor, appliances…)', 80),
  ('phone-load',      'Phone load',                   90),
  ('ac-cleaning',     'AC cleaning',                  100),
  ('royalty',         'Royalty',                      110),
  ('other',           'Other',                        200);
--> statement-breakpoint
INSERT INTO `recurring_expenses` (`id`, `category_id`, `description`, `amount`, `day_of_month`, `created_at`) VALUES
  ('bookkeeping-monthly', 'bookkeeping', 'Monthly bookkeeping', 125000, 1, '2026-11-04T00:00:00.000Z');
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0011_expenses_royalty' WHERE `key` = 'schema_version';
