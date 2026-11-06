import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { businessDayOf, isTopUpDay, topUpNeeded } from '@spa/domain';
import { cashTransfers, users } from '@spa/db';
import type { AuthedEnv } from '../env';
import { auditInsert } from '../lib/audit';
import { requireOpenDay } from '../lib/business-days';
import { fail, invalidInput } from '../lib/http';
import { currentTransferDay, handoverState, pettyCashNow, salesCashNow } from '../lib/sales-cash';
import { nowIso } from '../lib/time';
import { centavos, isoDate, todayInManila } from '../lib/validation';
import { requireAuth, requireCapability } from '../auth/middleware';

const amountBody = z.object({ amount: centavos.refine((a) => a > 0, 'Enter an amount.'), note: z.string().trim().max(300).optional() });

const receiveBody = z.object({
  receivedAmount: centavos,
  receivedOn: isoDate,
  /** Empty when the Super Admin received it personally. */
  receivedByName: z.string().trim().max(120).optional(),
  note: z.string().trim().max(300).optional(),
});

/**
 * Sales Cash kept at the shop, the Petty Cash Fund, and Cash Handovers to
 * the owner. Transfers move Sales Cash without spending it, so they are
 * not Expenses (ADR 0003).
 */
export const cashRoutes = new Hono<AuthedEnv>()
  .use('/cash/*', requireAuth, requireCapability('cashouts.record'))

  /** What's in the shop, what's due, and what to remind the Receptionist of. */
  .get('/cash/summary', async (c) => {
    const db = c.var.db;
    const today = businessDayOf(new Date());
    const [state, petty, lastHandover, waiting] = await Promise.all([
      handoverState(db, today),
      pettyCashNow(db),
      db.select().from(cashTransfers).where(eq(cashTransfers.kind, 'handover')).orderBy(desc(cashTransfers.createdAt)).get(),
      db.select().from(cashTransfers).where(and(eq(cashTransfers.kind, 'handover'), isNull(cashTransfers.confirmedAt))).orderBy(desc(cashTransfers.createdAt)),
    ]);
    const { now } = state;
    // A Reliever hands over all Sales Cash at the end of every Relief Shift, without the Payroll and Laundry rule.
    const relief = c.var.user.role === 'reliever';
    const reminder = relief ? (now.amount > 0 ? 'hand_over' : 'none') : state.reminder;
    return c.json({
      day: now.day,
      salesCash: now.amount,
      pettyCash: petty,
      topUpDue: isTopUpDay(today) ? topUpNeeded(petty) : 0,
      reminder,
      dueSince: relief ? null : state.dueSince,
      relief,
      payWeek: state.lastWeek,
      payrollReleased: state.payrollReleased,
      laundryPaid: state.laundryPaid,
      lastHandover: lastHandover ?? null,
      waiting,
    });
  })

  /** Handovers, Top-ups, Payroll paid from the shop and opening counts, newest first. */
  .get('/cash/transfers', zValidator('query', z.object({ from: isoDate, to: isoDate }), invalidInput), async (c) => {
    const { from, to } = c.req.valid('query');
    const rows = await c.var.db
      .select({ t: cashTransfers, createdByName: sql<string>`${users.firstName} || ' ' || ${users.lastName}` })
      .from(cashTransfers)
      .leftJoin(users, eq(users.id, cashTransfers.createdBy))
      .where(and(gte(cashTransfers.businessDay, from), lte(cashTransfers.businessDay, to)))
      .orderBy(desc(cashTransfers.createdAt))
      .limit(300);
    const confirmerIds = [...new Set(rows.map((r) => r.t.confirmedBy).filter((x): x is string => !!x))];
    const confirmers = confirmerIds.length
      ? await c.var.db
          .select({ id: users.id, name: sql<string>`${users.firstName} || ' ' || ${users.lastName}` })
          .from(users)
          .where(inArray(users.id, confirmerIds))
      : [];
    return c.json({
      transfers: rows.map((r) => ({
        ...r.t,
        createdByName: r.createdByName,
        confirmedByName: confirmers.find((u) => u.id === r.t.confirmedBy)?.name ?? null,
      })),
    });
  })

  /** The Receptionist hands Sales Cash to the owner; it waits for the owner to confirm receipt. */
  .post('/cash/handovers', zValidator('json', amountBody, invalidInput), async (c) => {
    const db = c.var.db;
    const input = c.req.valid('json');
    const now = await salesCashNow(db);
    if (input.amount > now.amount) {
      return fail(c, 409, 'more_than_in_shop', `Only ${(now.amount / 100).toFixed(2)} of sales cash should be in the shop. Check the count, or close the day first.`);
    }
    const id = crypto.randomUUID();
    await db.insert(cashTransfers).values({ id, kind: 'handover', amount: input.amount, businessDay: now.day, note: input.note || null, createdAt: nowIso(), createdBy: c.var.user.id });
    return c.json({ id }, 201);
  })

  /** The owner confirms a handover arrived: how much, when, and who received it if not them. */
  .post('/cash/handovers/:id/receive', requireCapability('cash.receive'), zValidator('json', receiveBody, invalidInput), async (c) => {
    const db = c.var.db;
    const row = await db.select().from(cashTransfers).where(eq(cashTransfers.id, c.req.param('id'))).get();
    if (!row || row.kind !== 'handover') return fail(c, 404, 'not_found', 'Handover not found.');
    if (row.confirmedAt) return fail(c, 409, 'already_received', 'This handover is already confirmed.');
    const input = c.req.valid('json');
    if (input.receivedOn > todayInManila()) return fail(c, 400, 'future_date', 'The date received cannot be in the future.');
    const set = {
      receivedAmount: input.receivedAmount,
      receivedOn: input.receivedOn,
      receivedByName: input.receivedByName || null,
      receiveNote: input.note || null,
      confirmedAt: nowIso(),
      confirmedBy: c.var.user.id,
    };
    await db.batch([
      db.update(cashTransfers).set(set).where(and(eq(cashTransfers.id, row.id), isNull(cashTransfers.confirmedAt))),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'cash.handover_receive', entity: 'cash_transfer', entityId: row.id, before: row, after: set }),
    ]);
    return c.json({ ok: true });
  })

  /** Moves Sales Cash into the Petty Cash Fund, back up to ₱800. */
  .post('/cash/petty-topups', zValidator('json', amountBody, invalidInput), async (c) => {
    const db = c.var.db;
    const input = c.req.valid('json');
    const needed = topUpNeeded(await pettyCashNow(db));
    if (input.amount > needed) return fail(c, 409, 'over_fund', `Petty cash only needs ${(needed / 100).toFixed(2)} to be back at 800.00.`);
    const id = crypto.randomUUID();
    const day = await currentTransferDay(db);
    await db.insert(cashTransfers).values({ id, kind: 'petty_topup', amount: input.amount, businessDay: day, note: input.note || null, createdAt: nowIso(), createdBy: c.var.user.id });
    return c.json({ id }, 201);
  })

  /** The owner's count of Sales Cash in the shop, where the running count starts again. */
  .post('/cash/opening', requireCapability('cash.receive'), zValidator('json', z.object({ amount: centavos, note: z.string().trim().max(300).optional() }), invalidInput), async (c) => {
    const db = c.var.db;
    const input = c.req.valid('json');
    const id = crypto.randomUUID();
    const day = await currentTransferDay(db);
    await db.batch([
      db.insert(cashTransfers).values({ id, kind: 'opening', amount: input.amount, businessDay: day, note: input.note || null, createdAt: nowIso(), createdBy: c.var.user.id }),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'cash.opening', entity: 'cash_transfer', entityId: id, after: { amount: input.amount, businessDay: day } }),
    ]);
    return c.json({ id, businessDay: day }, 201);
  })

  /** A handover or Top-up recorded by mistake, while its day is open and before the owner confirms it. */
  .delete('/cash/transfers/:id', async (c) => {
    const db = c.var.db;
    const row = await db.select().from(cashTransfers).where(eq(cashTransfers.id, c.req.param('id'))).get();
    if (!row) return fail(c, 404, 'not_found', 'Not found.');
    if (row.kind !== 'handover' && row.kind !== 'petty_topup') return fail(c, 409, 'not_removable', 'Only a handover or petty cash top-up can be removed here.');
    if (row.confirmedAt) return fail(c, 409, 'already_received', 'The owner has already confirmed this handover.');
    const blocked = await requireOpenDay(c, row.businessDay);
    if (blocked) return blocked;
    await db.batch([
      db.delete(cashTransfers).where(eq(cashTransfers.id, row.id)),
      auditInsert(db, { actorUserId: c.var.user.id, action: 'cash.transfer_delete', entity: 'cash_transfer', entityId: row.id, before: row }),
    ]);
    return c.json({ ok: true });
  });
