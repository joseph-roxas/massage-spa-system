import { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { businessDayOf } from '@spa/domain';
import { cashOuts, dtr, staff } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { openDayFor } from '../lib/business-days';
import { fail } from '../lib/http';
import { unpaidRelief } from '../lib/relief';
import { nowIso } from '../lib/time';
import { requireAuth, requireCapability } from '../auth/middleware';

// Mounted at the API root, so the guards are scoped to these paths.
const guard = [requireAuth, requireCapability('cashouts.record')] as const;

/** Outside Relievers on short cover are paid in cash from Sales Cash when the Receptionist returns. */
export const reliefRoutes = new Hono<AuthedEnv>()
  .use('/relief-pay', ...guard)
  .use('/relief-pay/*', ...guard)

  /** What each short-cover Outside Reliever is owed for Relief Shifts not paid yet. */
  .get('/relief-pay', async (c) => {
    const db = c.var.db;
    const people = await db
      .select()
      .from(staff)
      .where(and(eq(staff.kind, 'reliever'), eq(staff.reliefPay, 'on_return')));
    const owed = [];
    for (const p of people) {
      const u = await unpaidRelief(db, p.id);
      if (u.amount > 0) owed.push({ staffId: p.id, displayName: p.displayName, amount: u.amount, days: u.days.map((d) => d.date) });
    }
    return c.json({ owed });
  })

  /** Pays one Outside Reliever everything owed: a Relief pay Cash-out from Sales Cash. */
  .post('/relief-pay/:staffId', async (c) => {
    const db = c.var.db;
    const person = await db.select().from(staff).where(eq(staff.id, c.req.param('staffId'))).get();
    if (!person || person.kind !== 'reliever' || person.reliefPay !== 'on_return') return fail(c, 404, 'not_found', 'Outside Reliever not found.');
    const u = await unpaidRelief(db, person.id);
    if (u.amount <= 0) return fail(c, 409, 'nothing_owed', `${person.displayName} is not owed anything.`);
    const day = businessDayOf(new Date());
    const blocked = await openDayFor(c, day);
    if (blocked) return blocked;
    const id = crypto.randomUUID();
    const now = nowIso();
    const purpose = `Relief pay: ${person.displayName} (${u.days.map((d) => d.date).join(', ')})`;
    await db.batch([
      db.insert(cashOuts).values({ id, businessDay: day, category: 'relief_pay', source: 'sales', amount: u.amount, purpose, staffId: person.id, createdAt: now, createdBy: c.var.user.id }),
      db.update(dtr).set({ reliefPaidAt: now }).where(inArray(dtr.id, u.entryIds)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'relief.pay', entity: 'staff', entityId: person.id, after: { amount: u.amount, entries: u.entryIds, cashOutId: id } }),
    ]);
    return c.json({ id, amount: u.amount }, 201);
  });
