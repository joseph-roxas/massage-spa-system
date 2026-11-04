CREATE TABLE `voucher_endorsements` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`from_no` integer NOT NULL,
	`to_no` integer NOT NULL,
	`endorsed_on` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	`created_by` text,
	`received_at` text,
	`received_by` text,
	`receive_note` text,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`received_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `voucher_endorsements_service_idx` ON `voucher_endorsements` (`service_id`);--> statement-breakpoint
ALTER TABLE `services` ADD `voucher_prefix` text;--> statement-breakpoint
CREATE UNIQUE INDEX `services_voucher_prefix_unique` ON `services` (`voucher_prefix`);--> statement-breakpoint
ALTER TABLE `vouchers` ADD `card_no` integer;--> statement-breakpoint
ALTER TABLE `vouchers` ADD `endorsement_id` text REFERENCES voucher_endorsements(id);--> statement-breakpoint
ALTER TABLE `vouchers` ADD `imported_buyer` text;--> statement-breakpoint
ALTER TABLE `vouchers` ADD `imported_sold_on` text;--> statement-breakpoint
ALTER TABLE `vouchers` ADD `void_reason` text;--> statement-breakpoint
UPDATE `services` SET `voucher_prefix` = CASE `id`
  WHEN 'aroma-90' THEN 'NTL-AM'
  WHEN 'swedish-60' THEN 'NTL-SM'
  WHEN 'ventosa-90' THEN 'NTL-VM'
  WHEN 'thai-60' THEN 'NTL-TB'
END WHERE `id` IN ('aroma-90', 'swedish-60', 'ventosa-90', 'thai-60');
--> statement-breakpoint
-- The free ones of a sold Bundle are now whichever are redeemed last.
UPDATE `vouchers` SET `is_free` = 0 WHERE `voucher_sale_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0013_voucher_endorsements' WHERE `key` = 'schema_version';
