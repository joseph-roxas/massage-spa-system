CREATE TABLE `business_days` (
	`date` text PRIMARY KEY NOT NULL,
	`opened_at` text NOT NULL,
	`opened_by` text,
	`early_close_at` text,
	`early_close_reason` text,
	`early_close_by` text,
	`early_close_status` text,
	`closed_at` text,
	`closed_by` text,
	`expected_cash` integer,
	`expected_gcash` integer,
	`counted_cash` integer,
	`variance` integer,
	`close_note` text,
	`reopened_at` text,
	`reopened_by` text,
	FOREIGN KEY (`opened_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`early_close_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reopened_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `cash_outs` (
	`id` text PRIMARY KEY NOT NULL,
	`business_day` text NOT NULL,
	`category` text NOT NULL,
	`amount` integer NOT NULL,
	`purpose` text NOT NULL,
	`staff_id` text,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cash_outs_day_idx` ON `cash_outs` (`business_day`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`sale_id` text NOT NULL,
	`business_day` text NOT NULL,
	`method` text NOT NULL,
	`amount` integer NOT NULL,
	`gcash_ref` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `payments_day_idx` ON `payments` (`business_day`);--> statement-breakpoint
CREATE INDEX `payments_sale_idx` ON `payments` (`sale_id`);--> statement-breakpoint
CREATE TABLE `sale_addons` (
	`id` text PRIMARY KEY NOT NULL,
	`sale_id` text NOT NULL,
	`addon_id` text NOT NULL,
	`name` text NOT NULL,
	`price` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`addon_id`) REFERENCES `addons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sales` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`business_day` text NOT NULL,
	`status` text DEFAULT 'paid' NOT NULL,
	`service_id` text NOT NULL,
	`therapist_id` text NOT NULL,
	`regular_price` integer NOT NULL,
	`discount_type` text NOT NULL,
	`discount_ref` text,
	`discount_bp` integer DEFAULT 0 NOT NULL,
	`discount_amount` integer DEFAULT 0 NOT NULL,
	`service_amount` integer NOT NULL,
	`addons_total` integer DEFAULT 0 NOT NULL,
	`amount_due` integer NOT NULL,
	`foc_kind` text DEFAULT 'none' NOT NULL,
	`commission_bp` integer NOT NULL,
	`commission_amount` integer NOT NULL,
	`is_holiday` integer DEFAULT false NOT NULL,
	`booklet_invoice_no` text,
	`reason` text,
	`void_reason` text,
	`voided_by` text,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`therapist_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sales_day_idx` ON `sales` (`business_day`,`status`);--> statement-breakpoint
CREATE INDEX `sales_therapist_idx` ON `sales` (`therapist_id`,`business_day`);--> statement-breakpoint
CREATE UNIQUE INDEX `sales_one_per_booking` ON `sales` (`booking_id`) WHERE status = 'paid';--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0007_sales_and_day_close' WHERE `key` = 'schema_version';
