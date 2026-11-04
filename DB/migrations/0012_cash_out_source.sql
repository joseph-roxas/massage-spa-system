ALTER TABLE `cash_outs` ADD `source` text DEFAULT 'sales' NOT NULL;--> statement-breakpoint
UPDATE `cash_outs` SET `source` = 'petty' WHERE `category` = 'petty_cash';
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0012_cash_out_source' WHERE `key` = 'schema_version';
