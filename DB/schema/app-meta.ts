import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Key/value facts about the deployed database itself, e.g. schema_version. */
export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
