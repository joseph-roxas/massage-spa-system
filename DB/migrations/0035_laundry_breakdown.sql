ALTER TABLE `cash_outs` ADD `breakdown_json` text;
--> statement-breakpoint
-- Guest names saved before they were capitalized on entry are tidied once by the API on its next request.
INSERT OR REPLACE INTO `app_meta` (`key`, `value`) VALUES ('guest_names', 'to_tidy');
--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0035_laundry_breakdown' WHERE `key` = 'schema_version';
