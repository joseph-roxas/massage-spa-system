ALTER TABLE `dtr` ADD `reviewed_at` text;--> statement-breakpoint
ALTER TABLE `dtr` ADD `reviewed_by` text;--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0022_dtr_review' WHERE `key` = 'schema_version';
