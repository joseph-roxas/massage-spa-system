import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { auditLog } from '@spa/db';
import { nowIso } from './time';

export type AuditEntry = {
  actorUserId: string | null;
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
};

/** Builds the insert so callers can put it in the same db.batch() as the change itself. */
export function auditInsert(db: DrizzleD1Database, entry: AuditEntry) {
  return db.insert(auditLog).values({
    actorUserId: entry.actorUserId,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    beforeJson: entry.before === undefined ? null : JSON.stringify(entry.before),
    afterJson: entry.after === undefined ? null : JSON.stringify(entry.after),
    reason: entry.reason ?? null,
    createdAt: nowIso(),
  });
}
