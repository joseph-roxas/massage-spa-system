CREATE TABLE `addons` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`price` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `holidays` (
	`date` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`raises_commission` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `promos` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`service_id` text NOT NULL,
	`percent_bp` integer NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `promos_service_idx` ON `promos` (`service_id`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`is_flex` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `service_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`regular_price` integer NOT NULL,
	`effective_from` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_prices_service_from_idx` ON `service_prices` (`service_id`,`effective_from`);--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`duration_min` integer NOT NULL,
	`kind` text NOT NULL,
	`is_foot_type` integer DEFAULT false NOT NULL,
	`voucher_eligible` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `services_code_unique` ON `services` (`code`);--> statement-breakpoint
CREATE TABLE `commission_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`therapist_class` text NOT NULL,
	`normal_bp` integer NOT NULL,
	`holiday_bp` integer NOT NULL,
	`effective_from` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `commission_rates_class_from_idx` ON `commission_rates` (`therapist_class`,`effective_from`);--> statement-breakpoint
CREATE TABLE `pay_rules` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `staff` (
	`id` text PRIMARY KEY NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`display_name` text NOT NULL,
	`kind` text NOT NULL,
	`therapist_class` text,
	`is_on_call` integer DEFAULT false NOT NULL,
	`daily_rate` integer,
	`gov_sss` integer DEFAULT 0 NOT NULL,
	`gov_phic` integer DEFAULT 0 NOT NULL,
	`gov_pagibig` integer DEFAULT 0 NOT NULL,
	`pin_hash` text,
	`user_id` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0002_catalogue' WHERE `key` = 'schema_version';
