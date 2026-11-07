-- Production ran 0028 with `tin` before it was edited, so 0028 stays as it ran and this renames it.
ALTER TABLE `branding` RENAME COLUMN `tin` TO `contact_number`;--> statement-breakpoint
UPDATE `app_meta` SET `value` = '0029_contact_number' WHERE `key` = 'schema_version';
