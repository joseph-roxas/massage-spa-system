CREATE TABLE `takeout_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text,
	`item_text` text,
	`qty` integer NOT NULL,
	`level` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	`created_by` text,
	`resolved_at` text,
	`resolved_by` text,
	`dismiss_reason` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `takeout_requests_open_idx` ON `takeout_requests` (`resolved_at`);--> statement-breakpoint
CREATE TABLE `turnovers` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`qty` integer NOT NULL,
	`sent_on` text NOT NULL,
	`takeout_request_id` text,
	`note` text,
	`created_at` text NOT NULL,
	`created_by` text,
	`received_qty` integer,
	`received_at` text,
	`received_by` text,
	`receive_note` text,
	`shortfall_outcome` text,
	`shortfall_resolved_at` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`takeout_request_id`) REFERENCES `takeout_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`received_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `turnovers_item_idx` ON `turnovers` (`item_id`);--> statement-breakpoint
CREATE INDEX `turnovers_pending_idx` ON `turnovers` (`received_at`);--> statement-breakpoint
ALTER TABLE `items` ADD `kind` text DEFAULT 'consumable' NOT NULL;--> statement-breakpoint
ALTER TABLE `stock_ins` ADD `location` text DEFAULT 'storage' NOT NULL;--> statement-breakpoint
ALTER TABLE `stock_outs` ADD `kind` text DEFAULT 'use' NOT NULL;--> statement-breakpoint
ALTER TABLE `stock_outs` ADD `reason` text;--> statement-breakpoint
ALTER TABLE `stock_outs` ADD `location` text DEFAULT 'shop' NOT NULL;--> statement-breakpoint
-- Before Storage existed, everything on hand was at the shop.
UPDATE `stock_ins` SET `location` = 'shop';
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0015_storage_and_shop' WHERE `key` = 'schema_version';
