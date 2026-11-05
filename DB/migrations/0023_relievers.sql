ALTER TABLE `audit_log` ADD `acting_staff_id` text;--> statement-breakpoint
ALTER TABLE `dtr` ADD `is_relief` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `dtr` ADD `relief_paid_at` text;--> statement-breakpoint
ALTER TABLE `staff` ADD `relief_pay` text;--> statement-breakpoint
-- ADR 0005: whatever is done under the shared Reliever Login is credited to the Reliever clocked in on relief at that moment.
CREATE TRIGGER `audit_log_acting_staff` AFTER INSERT ON `audit_log`
WHEN NEW.`actor_user_id` IN (SELECT `id` FROM `users` WHERE `role` = 'reliever')
BEGIN
  UPDATE `audit_log` SET `acting_staff_id` = (SELECT `staff_id` FROM `dtr` WHERE `is_relief` = 1 AND `clock_out` IS NULL ORDER BY `clock_in` DESC LIMIT 1) WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0023_relievers' WHERE `key` = 'schema_version';
