ALTER TABLE `sales` ADD `catch_up` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- The week of Nov 2 is entered as real Sales from the paper records (ADR 0009).
INSERT OR REPLACE INTO `pay_rules` (`key`, `value_json`, `updated_at`) VALUES ('go_live_date', '"2026-11-02"', '2026-11-08T00:00:00.000Z');
--> statement-breakpoint
INSERT OR REPLACE INTO `holidays` (`date`, `name`, `type`, `raises_commission`) VALUES ('2026-11-02', 'All Souls'' Day', 'special', 1);
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0032_catch_up_week' WHERE `key` = 'schema_version';
