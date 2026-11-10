ALTER TABLE `dtr` ADD `auto_clock_out` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0033_auto_clock_out' WHERE `key` = 'schema_version';
