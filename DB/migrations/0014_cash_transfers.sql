CREATE TABLE `cash_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`business_day` text NOT NULL,
	`payroll_id` text,
	`note` text,
	`created_at` text NOT NULL,
	`created_by` text,
	`received_amount` integer,
	`received_on` text,
	`received_by_name` text,
	`receive_note` text,
	`confirmed_at` text,
	`confirmed_by` text,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`confirmed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cash_transfers_day_idx` ON `cash_transfers` (`business_day`);--> statement-breakpoint
CREATE INDEX `cash_transfers_kind_idx` ON `cash_transfers` (`kind`,`business_day`);--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0014_cash_transfers' WHERE `key` = 'schema_version';
