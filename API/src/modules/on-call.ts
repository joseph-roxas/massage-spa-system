import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { staff } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { name } from '../lib/validation';
import { requireAuth, requireCapability } from '../auth/middleware';
import { hashPassword } from '../auth/password';

const newOnCall = z.object({
  firstName: name,
  lastName: name,
  displayName: z.string().trim().max(40).optional(),
  pin: z.string().regex(/^\d{4}$/, 'The PIN must be exactly 4 digits.'),
});

/**
 * The Receptionist adds an On-call Therapist straight from the desk, so they can
 * clock in and join the Rotation at once. Always a Regular Therapist: only the
 * Super Admin can make someone an LMT, which raises their Commission.
 */
export const onCallRoutes = new Hono<AuthedEnv>().post('/on-call-therapists', requireAuth, requireCapability('staff.add_on_call'), zValidator('json', newOnCall, invalidInput), async (c) => {
  const db = c.var.db;
  const { pin, ...input } = c.req.valid('json');
  const displayName = input.displayName || input.firstName;
  const taken = await db
    .select({ id: staff.id })
    .from(staff)
    .where(and(eq(staff.active, true), sql`lower(${staff.displayName}) = lower(${displayName})`))
    .get();
  if (taken) return fail(c, 409, 'name_taken', `${displayName} is already on the Clock-in Screen. Use a different Shown as name, or have them clock in with their PIN.`);

  const id = crypto.randomUUID();
  const record = { firstName: input.firstName, lastName: input.lastName, displayName, kind: 'therapist' as const, therapistClass: 'regular' as const, isOnCall: true, govSss: 0, govPhic: 0, govPagibig: 0, active: true };
  await db.batch([
    db.insert(staff).values({ id, ...record, pinHash: await hashPassword(pin), createdAt: nowIso() }),
    auditInsert(db, { actorUserId: c.var.user.id, action: 'staff.create_on_call', entity: 'staff', entityId: id, after: record }),
  ]);
  return c.json({ id, displayName }, 201);
});
