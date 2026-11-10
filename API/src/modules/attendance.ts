import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { businessDayOf, can, isBirthday, payWeekOf, type Capability } from '@spa/domain';
import { dtr, holidays, payrolls, sales, staff } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { frontDeskState } from '../lib/front-desk';
import { fail, invalidInput } from '../lib/http';
import { nowIso } from '../lib/time';
import { isoDate } from '../lib/validation';
import { requireSessionOrDevice } from '../auth/device';
import { requireAuth, requireCapability } from '../auth/middleware';
import { clockOutForgotten } from '../lib/auto-clock-out';
import { verifyPassword } from '../auth/password';

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 5;

const instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s).toISOString());
const reason = z.string().trim().min(3, 'Give a short reason.').max(300);

const punchBody = z.object({
  staffId: z.string().min(1),
  pin: z.string().regex(/^\d{4}$/),
  action: z.enum(['in', 'out']),
  /** A Therapist clocking in to run the front desk: a Relief Shift. An Outside Reliever's clock-ins always are. */
  relief: z.boolean().default(false),
});

const entryBody = z.object({
  staffId: z.string().min(1),
  clockIn: instant,
  clockOut: instant.nullable(),
  reason,
  /** A Relief Shift (front desk) rather than therapist time. */
  isRelief: z.boolean().optional(),
});

const editBody = entryBody.omit({ staffId: true });

/** Several missing entries for one person at once: one shared reason, each row may give its own. */
const batchBody = z.object({
  staffId: z.string().min(1),
  reason,
  /** Every row is a Relief Shift. */
  isRelief: z.boolean().optional(),
  rows: z
    .array(z.object({ clockIn: instant, clockOut: instant.nullable(), reason: reason.optional() }))
    .min(1)
    .max(14),
});

/** Entries for the DTR Review: added by hand, corrected, ended by an Auto Clock-out, or never clocked out on an earlier day. */
const flagged = (today: string) => or(eq(dtr.source, 'manual'), isNotNull(dtr.correctedAt), eq(dtr.autoClockOut, true), and(isNull(dtr.clockOut), lt(dtr.businessDay, today)));
const needsReview = (today: string) => and(isNull(dtr.reviewedAt), flagged(today));

export async function dtrToReviewCount(db: AuthedEnv['Variables']['db']): Promise<number> {
  const row = await db
    .select({ n: sql<number>`count(*)` })
    .from(dtr)
    .where(needsReview(businessDayOf(new Date())))
    .get();
  return Number(row?.n ?? 0);
}

/** Who may correct whose DTR: the Receptionist corrects Therapists; the Super Admin everyone, Outside Relievers included. */
function correctionCapability(kind: 'therapist' | 'receptionist' | 'reliever'): Capability {
  return kind === 'therapist' ? 'dtr.correct.therapist' : 'dtr.correct.receptionist';
}

/** The Super Admin's word on a time record is final: what they enter counts as Reviewed. */
const isOwner = (c: Context<AuthedEnv>) => can(c.var.user.role, 'dtr.correct.receptionist');
const reviewStamp = (c: Context<AuthedEnv>, now: string) => (isOwner(c) ? { reviewedAt: now, reviewedBy: c.var.user.id } : { reviewedAt: null, reviewedBy: null });

/** A reviewed entry is the Super Admin's to change. Returns the error response, or null to go ahead. */
function lockedForDesk(c: Context<AuthedEnv>, entry: { reviewedAt: string | null }): Response | null {
  return entry.reviewedAt && !isOwner(c) ? fail(c, 409, 'dtr_locked', 'The owner has already checked this entry. Ask them to change it.') : null;
}

/** Time in a Pay Week whose Payroll is approved or released can't change, or the record and the Payslip disagree. */
async function payrollLocked(c: Context<AuthedEnv>, staffId: string, kind: 'therapist' | 'receptionist' | 'reliever', days: string[]): Promise<Response | null> {
  const weeks = [...new Set(days.map((d) => payWeekOf(d, kind).start))];
  const fixed = await c.var.db
    .select({ weekStart: payrolls.weekStart })
    .from(payrolls)
    .where(and(eq(payrolls.staffId, staffId), inArray(payrolls.weekStart, weeks), ne(payrolls.status, 'draft')))
    .get();
  return fixed ? fail(c, 409, 'payroll_locked', `The Payroll for the week of ${fixed.weekStart} is already approved. Send it back to draft first.`) : null;
}

/** An Outside Reliever's time is always a Relief Shift; a Therapist's when marked so; the Receptionist's never. */
const reliefFor = (kind: 'therapist' | 'receptionist' | 'reliever', marked: boolean | undefined) => kind === 'reliever' || (kind === 'therapist' && !!marked);

const whenLabel = (iso: string) =>
  new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dayLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-PH', { timeZone: 'UTC', month: 'short', day: 'numeric' });

/** Names the entry a change runs into, so it can be found on its own day. */
export function overlapMessage(e: { businessDay: string; clockIn: string; clockOut: string | null }): string {
  const span = `${whenLabel(e.clockIn)} to ${e.clockOut ? whenLabel(e.clockOut) : 'now (never clocked out)'}`;
  return `This overlaps another entry for the same person: ${span}, filed under ${dayLabel(e.businessDay)}. Open that day to correct or remove it.`;
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
  const clash = others.find((e) => clockIn < (e.clockOut ?? '9999') && e.clockIn < end);
  if (clash) return overlapMessage(clash);
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
  // The Front-desk Device reaches the Clock-in Screen with no one logged in (ADR 0004).
  .use('/clock/*', requireSessionOrDevice as unknown as typeof requireAuth)
  .use('/dtr', requireAuth)
  .use('/dtr/*', requireAuth)
  .use('/rotation', requireAuth)

  // ---- Clock-in Screen (logged in, or on the Front-desk Device) ----
  .get('/clock/staff', async (c) => {
    const db = c.var.db;
    // Last night's forgotten clock-outs end before anyone sees who is in (Auto Clock-out).
    await clockOutForgotten(db);
    const day = businessDayOf(new Date());
    const [people, open, holiday] = await Promise.all([
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
      db.select({ staffId: dtr.staffId, clockIn: dtr.clockIn, isRelief: dtr.isRelief }).from(dtr).where(isNull(dtr.clockOut)),
      db.select({ name: holidays.name, type: holidays.type }).from(holidays).where(eq(holidays.date, day)).get(),
    ]);
    return c.json({
      today: { day, holiday: holiday ?? null },
      staff: people.map(({ pinHash, ...p }) => ({
        ...p,
        hasPin: pinHash !== null,
        clockedInAt: open.find((o) => o.staffId === p.id)?.clockIn ?? null,
        relieving: open.find((o) => o.staffId === p.id)?.isRelief ?? false,
      })),
    });
  })
  .post('/clock/punch', zValidator('json', punchBody, invalidInput), async (c) => {
    const { staffId, pin, action, relief } = c.req.valid('json');
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

    await clockOutForgotten(db);
    const open = await db
      .select()
      .from(dtr)
      .where(and(eq(dtr.staffId, staffId), isNull(dtr.clockOut)))
      .get();
    const reset = db.update(staff).set({ pinFailedCount: 0, pinLockedUntil: null }).where(eq(staff.id, staffId));

    // A birthday greeting on the first clock-in of the day only.
    let birthday = false;
    if (action === 'in') {
      if (open) return fail(c, 409, 'already_in', `${person.displayName} is already clocked in.`);
      const day = businessDayOf(new Date(now));
      const earlier = await db
        .select({ id: dtr.id })
        .from(dtr)
        .where(and(eq(dtr.staffId, staffId), eq(dtr.businessDay, day)))
        .get();
      birthday = !earlier && isBirthday(person.birthdate, day);
      await db.batch([
        reset,
        db.insert(dtr).values({
          id: crypto.randomUUID(),
          staffId,
          businessDay: businessDayOf(new Date(now)),
          clockIn: now,
          source: 'pin',
          createdAt: now,
          isRelief: person.kind === 'reliever' || (person.kind === 'therapist' && relief),
        }),
      ]);
    } else {
      if (!open) return fail(c, 409, 'not_in', `${person.displayName} is not clocked in.`);
      await db.batch([reset, db.update(dtr).set({ clockOut: now }).where(eq(dtr.id, open.id))]);
    }
    // Therapists see what they have earned so far this Pay Week (On-call: today) on the Clock-in Screen.
    let earnings: { from: string; commission: number; services: number } | null = null;
    if (person.kind === 'therapist') {
      const day = businessDayOf(new Date(now));
      const from = person.isOnCall ? day : payWeekOf(day, 'therapist').start;
      const row = await db
        .select({ commission: sql<number>`coalesce(sum(${sales.commissionAmount}), 0)`, services: sql<number>`count(*)` })
        .from(sales)
        .where(and(eq(sales.therapistId, staffId), eq(sales.status, 'paid'), gte(sales.businessDay, from), lte(sales.businessDay, day)))
        .get();
      earnings = { from, commission: Number(row?.commission ?? 0), services: Number(row?.services ?? 0) };
    }
    return c.json({ staffId, displayName: person.displayName, firstName: person.firstName, action, at: now, earnings, birthday });
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
        correctedBy: dtr.correctedBy,
        correctionReason: dtr.correctionReason,
        isRelief: dtr.isRelief,
        autoClockOut: dtr.autoClockOut,
        reviewedAt: dtr.reviewedAt,
        reviewedBy: dtr.reviewedBy,
      })
      .from(dtr)
      .innerJoin(staff, eq(staff.id, dtr.staffId))
      .where(eq(dtr.businessDay, day))
      .orderBy(asc(dtr.clockIn));
    return c.json({
      day,
      entries: rows.map(({ correctedBy, reviewedBy, ...r }) => {
        const locked = !!r.reviewedAt && !isOwner(c);
        return {
          ...r,
          canEdit: can(c.var.user.role, correctionCapability(r.kind)) && !locked,
          lockedAs: !locked ? null : correctedBy === reviewedBy ? 'corrected' : 'checked',
        };
      }),
    });
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
    const blocked = await payrollLocked(c, input.staffId, person.kind, [businessDayOf(new Date(input.clockIn))]);
    if (blocked) return blocked;
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
      isRelief: reliefFor(person.kind, input.isRelief),
      ...reviewStamp(c, now),
    };
    await db.batch([
      db.insert(dtr).values(entry),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'dtr.add', entity: 'dtr', entityId: id, after: entry, reason: input.reason }),
    ]);
    return c.json({ id }, 201);
  })
  /** Several missing entries for one person, saved together or not at all. */
  .post('/dtr/batch', zValidator('json', batchBody, invalidInput), async (c) => {
    const input = c.req.valid('json');
    const db = c.var.db;
    const person = await db.select({ kind: staff.kind }).from(staff).where(eq(staff.id, input.staffId)).get();
    if (!person) return fail(c, 404, 'not_found', 'Staff member not found.');
    if (!can(c.var.user.role, correctionCapability(person.kind))) {
      return fail(c, 403, 'forbidden', 'You cannot change this person’s time record.');
    }
    const problems: { index: number; message: string }[] = [];
    for (const [i, row] of input.rows.entries()) {
      const problem = await entryProblem(c, input.staffId, row.clockIn, row.clockOut);
      // Rows must not overlap each other either.
      const clash = input.rows.findIndex(
        (other, j) => j !== i && row.clockIn < (other.clockOut ?? '9999') && other.clockIn < (row.clockOut ?? '9999'),
      );
      const message = problem ?? (clash >= 0 ? `This overlaps row ${clash + 1}.` : null);
      if (message) problems.push({ index: i, message });
    }
    if (input.rows.filter((r) => r.clockOut === null).length > 1) problems.push({ index: input.rows.length - 1, message: 'Only one entry can be left without a clock-out.' });
    if (problems.length) {
      return c.json({ error: 'invalid_rows', message: `${problems.length === 1 ? 'A row needs' : `${problems.length} rows need`} fixing; nothing was saved.`, problems }, 400);
    }
    const blocked = await payrollLocked(c, input.staffId, person.kind, input.rows.map((r) => businessDayOf(new Date(r.clockIn))));
    if (blocked) return blocked;
    const now = nowIso();
    const entries = input.rows.map((row) => ({
      id: crypto.randomUUID(),
      staffId: input.staffId,
      businessDay: businessDayOf(new Date(row.clockIn)),
      clockIn: row.clockIn,
      clockOut: row.clockOut,
      source: 'manual' as const,
      createdAt: now,
      correctedBy: c.var.user.id,
      correctedAt: now,
      correctionReason: row.reason || input.reason,
      isRelief: reliefFor(person.kind, input.isRelief),
      ...reviewStamp(c, now),
    }));
    await db.batch([
      auditInsert(db, { actorUserId: c.var.user.id, action: 'dtr.add_batch', entity: 'staff', entityId: input.staffId, after: entries, reason: input.reason }),
      ...entries.map((e) => db.insert(dtr).values(e)),
    ]);
    return c.json({ ids: entries.map((e) => e.id) }, 201);
  })

  /** The DTR Review list, any date: what still needs a look, or everything flagged with `all`. */
  .get('/dtr/review', requireCapability('dtr.correct.receptionist'), zValidator('query', z.object({ all: z.enum(['1']).optional() }), invalidInput), async (c) => {
    const today = businessDayOf(new Date());
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
        isRelief: dtr.isRelief,
        autoClockOut: dtr.autoClockOut,
        reviewedAt: dtr.reviewedAt,
      })
      .from(dtr)
      .innerJoin(staff, eq(staff.id, dtr.staffId))
      .where(c.req.valid('query').all ? flagged(today) : needsReview(today))
      .orderBy(desc(dtr.businessDay), asc(dtr.clockIn))
      .limit(300);
    return c.json({ entries: rows.map((r) => ({ ...r, canEdit: true })) });
  })

  .post('/dtr/review', requireCapability('dtr.correct.receptionist'), zValidator('json', z.object({ ids: z.array(z.string().min(1)).min(1).max(90) }), invalidInput), async (c) => {
    const db = c.var.db;
    const { ids } = c.req.valid('json');
    await db.batch([
      db.update(dtr).set({ reviewedAt: nowIso(), reviewedBy: c.var.user.id }).where(inArray(dtr.id, ids)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'dtr.review', entity: 'dtr', entityId: ids.length === 1 ? ids[0]! : `${ids.length} entries`, after: { ids } }),
    ]);
    return c.json({ ok: true });
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
    const locked = lockedForDesk(c, row.entry);
    if (locked) return locked;
    const input = c.req.valid('json');
    const problem = await entryProblem(c, row.entry.staffId, input.clockIn, input.clockOut, id);
    if (problem) return fail(c, 400, 'invalid_entry', problem);
    const businessDay = businessDayOf(new Date(input.clockIn));
    const blocked = await payrollLocked(c, row.entry.staffId, row.kind, [row.entry.businessDay, businessDay]);
    if (blocked) return blocked;
    const now = nowIso();
    const changes = {
      clockIn: input.clockIn,
      clockOut: input.clockOut,
      businessDay,
      correctedBy: c.var.user.id,
      correctedAt: now,
      correctionReason: input.reason,
      ...(input.isRelief !== undefined ? { isRelief: reliefFor(row.kind, input.isRelief) } : {}),
      // The Super Admin's own correction is Reviewed; anyone else's goes on the DTR Review list.
      ...reviewStamp(c, now),
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
    const locked = lockedForDesk(c, row.entry);
    if (locked) return locked;
    const blocked = await payrollLocked(c, row.entry.staffId, row.kind, [row.entry.businessDay]);
    if (blocked) return blocked;
    const { reason: why } = c.req.valid('json');
    await db.batch([
      db.delete(dtr).where(eq(dtr.id, id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'dtr.delete', entity: 'dtr', entityId: id, before: row.entry, reason: why }),
    ]);
    return c.json({ ok: true });
  })

  // ---- Rotation ----
  .get('/rotation', requireCapability('bookings.manage'), async (c) => {
    const now = nowIso();
    const day = businessDayOf(new Date(now));
    const state = await frontDeskState(c.var.db, day, now);
    const byId = new Map(state.therapists.map((t) => [t.id, t]));
    return c.json({
      day,
      next: state.next?.staffId ?? null,
      rotation: state.rotation.map((r) => ({ ...r, ...byId.get(r.staffId)! })),
    });
  });
