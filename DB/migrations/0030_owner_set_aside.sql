CREATE TABLE `service_set_asides` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`amount` integer NOT NULL,
	`effective_from` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_set_asides_service_from_idx` ON `service_set_asides` (`service_id`,`effective_from`);--> statement-breakpoint
ALTER TABLE `sales` ADD `set_aside` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
INSERT INTO `service_set_asides` (`id`, `service_id`, `amount`, `effective_from`, `created_at`) VALUES
  ('sa-aroma-90', 'aroma-90', 5000, '2026-11-02', '2026-11-08T00:00:00.000Z'),
  ('sa-hotoil-90', 'hotoil-90', 5000, '2026-11-02', '2026-11-08T00:00:00.000Z'),
  ('sa-hotstone-90', 'hotstone-90', 5000, '2026-11-02', '2026-11-08T00:00:00.000Z');
--> statement-breakpoint
UPDATE `addons` SET `active` = 0;
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0030_owner_set_aside' WHERE `key` = 'schema_version';
