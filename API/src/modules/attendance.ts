import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import { businessDayOf, can, computeRotation, nextInRotation, type Capability } from '@spa/domain';
import { dtr, staff } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { isoDate } from '../lib/validation';
import { requireAuth, requireCapability } from '../auth/middleware';
import { verifyPassword } from '../auth/password';

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 5;

const instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s).toISOString());
const reason = z.string().trim().min(3, 'Give a short reason.').max(300);

const punchBody = z.object({
  staffId: z.string().min(1),
  pin: z.string().regex(/^\d{4}$/),
  action: z.enum(['in', 'out']),
});

const entryBody = z.object({
  staffId: z.string().min(1),
  clockIn: instant,
  clockOut: instant.nullable(),
  reason,
});

const editBody = entryBody.omit({ staffId: true });

/** Who may correct whose DTR: the Receptionist can't edit her own kind's records. */
function correctionCapability(kind: 'therapist' | 'receptionist'): Capability {
  return kind === 'therapist' ? 'dtr.correct.therapist' : 'dtr.correct.receptionist';
}

/** Problems with a proposed entry, checked against the person's other entries. */
async function entryProblem(
  c: Context<AuthedEnv>,
  staffId: string,
  clockIn: string,
  clockOut: string | null,
  excludeId?: string,
): Promise<string | null> {
  const now = nowIso();
  if (clockIn > now || (clockOut && clockOut > now)) return 'Times cannot be in the future.';
  if (clockOut && clockOut <= clockIn) return 'Clock-out must be after clock-in.';
  // Look a few days either side; shifts never span longer than that.
  const from = new Date(new Date(clockIn).getTime() - 3 * 86_400_000).toISOString();
  const to = new Date(new Date(clockOut ?? now).getTime() + 3 * 86_400_000).toISOString();
  const others = (
    await c.var.db
      .select()
      .from(dtr)
      .where(and(eq(dtr.staffId, staffId), gte(dtr.clockIn, from), lte(dtr.clockIn, to)))
  ).filter((e) => e.id !== excludeId);
  const end = clockOut ?? '9999';
  for (const e of others) {
    if (clockIn < (e.clockOut ?? '9999') && e.clockIn < end) return 'This overlaps another entry for the same person.';
  }
  if (clockOut === null) {
    const open = await c.var.db
      .select({ id: dtr.id })
      .from(dtr)
      .where(and(eq(dtr.staffId, staffId), isNull(dtr.clockOut)))
      .all();
    if (open.some((o) => o.id !== excludeId)) return 'This person is already clocked in.';
  }
  return null;
}

// Mounted at the API root, so login is required per path rather than for everything.
export const attendanceRoutes = new Hono<AuthedEnv>()
  .use('/clock/*', requireAuth)
  .use('/dtr', requireAuth)
  .use('/dtr/*', requireAuth)
  .use('/rotation', requireAuth)

  // ---- Clock-in Screen (on the logged-in front-desk device) ----
  .get('/clock/staff', async (c) => {
    const db = c.var.db;
    const [people, open] = await Promise.all([
      db
        .select({
          id: staff.id,
          displayName: staff.displayName,
          kind: staff.kind,
          therapistClass: staff.therapistClass,
          isOnCall: staff.isOnCall,
          pinHash: staff.pinHash,
        })
        .from(staff)
        .where(eq(staff.active, true))
        .orderBy(asc(staff.kind), asc(staff.displayName)),
      db.select({ staffId: dtr.staffId, clockIn: dtr.clockIn }).from(dtr).where(isNull(dtr.clockOut)),
    ]);
    return c.json({
      staff: people.map(({ pinHash, ...p }) => ({
        ...p,
        hasPin: pinHash !== null,
        clockedInAt: open.find((o) => o.staffId === p.id)?.clockIn ?? null,
      })),
    });
  })
  .post('/clock/punch', zValidator('json', punchBody, invalidInput), async (c) => {
    const { staffId, pin, action } = c.req.valid('json');
    const db = c.var.db;
    const person = await db.select().from(staff).where(eq(staff.id, staffId)).get();
    if (!person || !person.active) return fail(c, 404, 'not_found', 'Staff member not found.');
    if (!person.pinHash) return fail(c, 409, 'no_pin', 'No PIN set yet. Ask the owner to set one.');

    const now = nowIso();
    if (person.pinLockedUntil && person.pinLockedUntil > now) {
      return fail(c, 423, 'pin_locked', 'Too many wrong PINs. Try again in a few minutes.');
    }
    if (!(await verifyPassword(pin, person.pinHash))) {
      const failed = person.pinFailedCount + 1;
      const locked = failed >= MAX_PIN_ATTEMPTS;
      await db
        .update(staff)
        .set({
          pinFailedCount: locked ? 0 : failed,
          pinLockedUntil: locked ? new Date(Date.now() + PIN_LOCK_MINUTES * 60_000).toISOString() : null,
        })
        .where(eq(staff.id, staffId));
      return locked
        ? fail(c, 423, 'pin_locked', `Too many wrong PINs. Locked for ${PIN_LOCK_MINUTES} minutes.`)
        : fail(c, 401, 'wrong_pin', `Wrong PIN. ${MAX_PIN_ATTEMPTS - failed} tries left.`);
    }

    const open = await db
      .select()
      .from(dtr)
      .where(and(eq(dtr.staffId, staffId), isNull(dtr.clockOut)))
      .get();
    const reset = db.update(staff).set({ pinFailedCount: 0, pinLockedUntil: null }).where(eq(staff.id, staffId));

    if (action === 'in') {
      if (open) return fail(c, 409, 'already_in', `${person.displayName} is already clocked in.`);
      await db.batch([
        reset,
        db.insert(dtr).values({
          id: crypto.randomUUID(),
          staffId,
          businessDay: businessDayOf(new Date(now)),
          clockIn: now,
          source: 'pin',
          createdAt: now,
        }),
      ]);
    } else {
      if (!open) return fail(c, 409, 'not_in', `${person.displayName} is not clocked in.`);
      await db.batch([reset, db.update(dtr).set({ clockOut: now }).where(eq(dtr.id, open.id))]);
    }
    return c.json({ staffId, displayName: person.displayName, action, at: now });
  })

  // ---- DTR review and corrections ----
  .get('/dtr', requireCapability('dtr.correct.therapist'), zValidator('query', z.object({ day: isoDate.optional() }), invalidInput), async (c) => {
    const day = c.req.valid('query').day ?? businessDayOf(new Date());
    const rows = await c.var.db
      .select({
        id: dtr.id,
        staffId: dtr.staffId,
        displayName: staff.displayName,
        kind: staff.kind,
        businessDay: dtr.businessDay,
        clockIn: dtr.clockIn,
        clockOut: dtr.clockOut,
        source: dtr.source,
        correctedAt: dtr.correctedAt,
        correctionReason: dtr.correctionReason,
      })
      .from(dtr)
      .innerJoin(staff, eq(staff.id, dtr.staffId))
      .where(eq(dtr.businessDay, day))
      .orderBy(asc(dtr.clockIn));
    return c.json({ day, entries: rows.map((r) => ({ ...r, canEdit: can(c.var.user.role, correctionCapability(r.kind)) })) });
  })
  .post('/dtr', zValidator('json', entryBody, invalidInput), async (c) => {
    const input = c.req.valid('json');
    const db = c.var.db;
    const person = await db.select({ kind: staff.kind }).from(staff).where(eq(staff.id, input.staffId)).get();
    if (!person) return fail(c, 404, 'not_found', 'Staff member not found.');
    if (!can(c.var.user.role, correctionCapability(person.kind))) {
      return fail(c, 403, 'forbidden', 'You cannot change this person’s time record.');
    }
    const problem = await entryProblem(c, input.staffId, input.clockIn, input.clockOut);
    if (problem) return fail(c, 400, 'invalid_entry', problem);
    const id = crypto.randomUUID();
    const now = nowIso();
    const entry = {
      id,
      staffId: input.staffId,
      businessDay: businessDayOf(new Date(input.clockIn)),
      clockIn: input.clockIn,
      clockOut: input.clockOut,
      source: 'manual' as const,
      createdAt: now,
      correctedBy: c.var.user.id,
      correctedAt: now,
      correctionReason: input.reason,
    };
    await db.batch([
      db.insert(dtr).values(entry),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'dtr.add', entity: 'dtr', entityId: id, after: entry, reason: input.reason }),
    ]);
    return c.json({ id }, 201);
  })
  .patch('/dtr/:id', zValidator('json', editBody, invalidInput), async (c) => {
    const db = c.var.db;
    const id = c.req.param('id');
    const row = await db
      .select({ entry: dtr, kind: staff.kind })
      .from(dtr)
      .innerJoin(staff, eq(staff.id, dtr.staffId))
      .where(eq(dtr.id, id))
      .get();
    if (!row) return fail(c, 404, 'not_found', 'Entry not found.');
    if (!can(c.var.user.role, correctionCapability(row.kind))) {
      return fail(c, 403, 'forbidden', 'You cannot change this person’s time record.');
    }
    const input = c.req.valid('json');
    const problem = await entryProblem(c, row.entry.staffId, input.clockIn, input.clockOut, id);
    if (problem) return fail(c, 400, 'invalid_entry', problem);
    const changes = {
      clockIn: input.clockIn,
      clockOut: input.clockOut,
      businessDay: businessDayOf(new Date(input.clockIn)),
      correctedBy: c.var.user.id,
      correctedAt: nowIso(),
      correctionReason: input.reason,
    };
    await db.batch([
      db.update(dtr).set(changes).where(eq(dtr.id, id)),
      auditInsert(db, {
        actorUserId: c.var.user.id,
        action: 'dtr.correct',
        entity: 'dtr',
        entityId: id,
        before: { clockIn: row.entry.clockIn, clockOut: row.entry.clockOut },
        after: { clockIn: input.clockIn, clockOut: input.clockOut },
        reason: input.reason,
      }),
    ]);
    return c.json({ ok: true });
  })
  .delete('/dtr/:id', zValidator('json', z.object({ reason }), invalidInput), async (c) => {
    const db = c.var.db;
    const id = c.req.param('id');
    const row = await db
      .select({ entry: dtr, kind: staff.kind })
      .from(dtr)
      .innerJoin(staff, eq(staff.id, dtr.staffId))
      .where(eq(dtr.id, id))
      .get();
    if (!row) return fail(c, 404, 'not_found', 'Entry not found.');
    if (!can(c.var.user.role, correctionCapability(row.kind))) {
      return fail(c, 403, 'forbidden', 'You cannot change this person’s time record.');
    }
    const { reason: why } = c.req.valid('json');
    await db.batch([
      db.delete(dtr).where(eq(dtr.id, id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'dtr.delete', entity: 'dtr', entityId: id, before: row.entry, reason: why }),
    ]);
    return c.json({ ok: true });
  })

  // ---- Rotation ----
  .get('/rotation', requireCapability('bookings.manage'), async (c) => {
    const db = c.var.db;
    const day = businessDayOf(new Date());
    const [therapists, entries] = await Promise.all([
      db
        .select({ id: staff.id, displayName: staff.displayName, therapistClass: staff.therapistClass, isOnCall: staff.isOnCall })
        .from(staff)
        .where(and(eq(staff.kind, 'therapist'), eq(staff.active, true))),
      db.select().from(dtr).where(eq(dtr.businessDay, day)),
    ]);
    // Service turns come from bookings (Phase 4); until then everyone on duty is free.
    const rotation = computeRotation(
      therapists.map((t) => ({ staffId: t.id, shifts: entries.filter((e) => e.staffId === t.id) })),
      [],
    );
    const byId = new Map(therapists.map((t) => [t.id, t]));
    return c.json({
      day,
      next: nextInRotation(rotation)?.staffId ?? null,
      rotation: rotation.map((r) => ({ ...r, ...byId.get(r.staffId)! })),
    });
  });
