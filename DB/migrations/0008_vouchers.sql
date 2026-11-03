CREATE TABLE `voucher_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`voucher_sale_id` text NOT NULL,
	`business_day` text NOT NULL,
	`method` text NOT NULL,
	`amount` integer NOT NULL,
	`gcash_ref` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`voucher_sale_id`) REFERENCES `voucher_sales`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `voucher_payments_day_idx` ON `voucher_payments` (`business_day`);--> statement-breakpoint
CREATE TABLE `voucher_sales` (
	`id` text PRIMARY KEY NOT NULL,
	`business_day` text NOT NULL,
	`status` text DEFAULT 'paid' NOT NULL,
	`service_id` text NOT NULL,
	`buyer_name` text,
	`buyer_phone` text,
	`qty_paid` integer NOT NULL,
	`qty_free` integer NOT NULL,
	`unit_price` integer NOT NULL,
	`total` integer NOT NULL,
	`void_reason` text,
	`voided_by` text,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `voucher_sales_day_idx` ON `voucher_sales` (`business_day`,`status`);--> statement-breakpoint
CREATE TABLE `vouchers` (
	`id` text PRIMARY KEY NOT NULL,
	`serial` text NOT NULL,
	`service_id` text NOT NULL,
	`voucher_sale_id` text,
	`is_free` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'unused' NOT NULL,
	`redeemed_sale_id` text,
	`redeemed_at` text,
	`imported` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voucher_sale_id`) REFERENCES `voucher_sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`redeemed_sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vouchers_serial_unique` ON `vouchers` (`serial`);--> statement-breakpoint
CREATE INDEX `vouchers_sale_idx` ON `vouchers` (`voucher_sale_id`);--> statement-breakpoint
CREATE INDEX `vouchers_status_idx` ON `vouchers` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `sales_one_per_voucher` ON `sales` (`discount_ref`) WHERE discount_type = 'voucher' AND status = 'paid';--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0008_vouchers' WHERE `key` = 'schema_version';
