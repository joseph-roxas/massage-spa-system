import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Key/value facts about the deployed database itself, e.g. schema_version. */
export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/** The business's own name and logo; one row, shown before anyone logs in. */
export const branding = sqliteTable('branding', {
  id: integer('id').primaryKey(),
  businessName: text('business_name'),
  /** A small image as a data URL, shrunk in the browser. */
  logo: text('logo'),
  updatedAt: text('updated_at').notNull(),
  updatedBy: text('updated_by'),
});
