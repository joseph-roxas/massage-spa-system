ALTER TABLE `branding` ADD `tin` text;--> statement-breakpoint
ALTER TABLE `branding` ADD `address` text;--> statement-breakpoint
ALTER TABLE `deduction_ledger` ADD `weeks_json` text;--> statement-breakpoint
ALTER TABLE `payrolls` ADD `gov_agreed` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0028_deferred_weeks' WHERE `key` = 'schema_version';
