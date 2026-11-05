import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Append-only record of every change: who, what, before/after, and why. */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    actorUserId: text('actor_user_id'),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
    reason: text('reason'),
    /** Under the shared Reliever Login: the Reliever clocked in on relief at the time (filled by a trigger). */
    actingStaffId: text('acting_staff_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('audit_entity_idx').on(t.entity, t.entityId)],
);
