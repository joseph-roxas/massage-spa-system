import { env } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';
import { businessDayOf, monthOf, monthRange, previousMonth } from '@spa/domain';
import { monthlyJobs } from '../src/modules/expenses';
import { loggedIn } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type Expense = { id: string; categoryId: string; amount: number; status: string; royaltyMonth: string | null; recurringExpenseId: string | null };
type Month = { expenses: Expense[]; cashOuts: { id: string; category: string; amount: number }[]; purchases: { total: number; fromDrawer: boolean }[]; totals: Record<string, number> };

const today = () => businessDayOf(new Date());
const thisMonth = () => monthOf(today());
const lastMonth = () => previousMonth(thisMonth());

async function pastSale(day: string, serviceAmount: number, status = 'paid') {
  const now = new Date().toISOString();
  const booking = crypto.randomUUID();
  const staffId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO staff (id, first_name, last_name, display_name, kind, therapist_class, created_at) VALUES (?, 'R', 'T', 'RT', 'therapist', 'regular', ?)`).bind(staffId, now),
    env.DB.prepare(`INSERT INTO bookings (id, business_day, kind, status, service_id, duration_min, created_at) VALUES (?, ?, 'walk_in', 'done', 'swedish-60', 60, ?)`).bind(booking, day, now),
    env.DB.prepare(
      `INSERT INTO sales (id, booking_id, business_day, status, service_id, therapist_id, regular_price, discount_type, service_amount, amount_due, commission_bp, commission_amount, created_at)
       VALUES (?, ?, ?, ?, 'swedish-60', ?, 50000, 'none', ?, ?, 3000, 15000, ?)`,
    ).bind(crypto.randomUUID(), booking, day, status, staffId, serviceAmount, serviceAmount, now),
  ]);
}

async function pastVoucherSale(day: string, total: number) {
  await env.DB.prepare(
    `INSERT INTO voucher_sales (id, business_day, status, service_id, qty_paid, qty_free, unit_price, total, created_at) VALUES (?, ?, 'paid', 'thai-60', 5, 1, 50000, ?, ?)`,
  )
    .bind(crypto.randomUUID(), day, total, new Date().toISOString())
    .run();
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM expenses`),
    env.DB.prepare(`DELETE FROM royalty_statements`),
    env.DB.prepare(`DELETE FROM stock_ins`),
    env.DB.prepare(`DELETE FROM cash_outs`),
    env.DB.prepare(`DELETE FROM payments`),
    env.DB.prepare(`DELETE FROM sales`),
    env.DB.prepare(`DELETE FROM bookings`),
    env.DB.prepare(`DELETE FROM voucher_payments`),
    env.DB.prepare(`DELETE FROM vouchers`),
    env.DB.prepare(`DELETE FROM voucher_sales`),
    env.DB.prepare(`DELETE FROM business_days`),
  ]);
});

describe('royalty', () => {
  it('is 3% of Service payments after Discounts plus Vouchers sold, drafted then confirmed', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const m = lastMonth();
    const { start, end } = monthRange(m);
    await pastSale(start, 50000);
    await pastSale(end, 40000); // Senior Citizen
    await pastSale(end, 0); // Voucher Redemption or Real FOC
    await pastSale(end, 50000, 'voided');
    await pastVoucherSale(start, 250000);
    await pastSale(`${thisMonth()}-01`, 99900); // next month: not counted

    expect((await desk.post(`/royalty/${m}/compute`)).status).toBe(403);
    expect((await admin.post(`/royalty/${thisMonth()}/compute`)).status).toBe(409);
    const { statement } = await json<{ statement: { grossSales: number; serviceSales: number; voucherSales: number; amount: number } }>(await admin.post(`/royalty/${m}/compute`));
    expect(statement).toMatchObject({ serviceSales: 90000, voucherSales: 250000, grossSales: 340000, amount: 10200 });

    const month = async () => json<Month>(await admin.get(`/expenses?month=${m}`));
    expect((await month()).expenses).toEqual([expect.objectContaining({ categoryId: 'royalty', amount: 10200, status: 'pending', royaltyMonth: m })]);

    // A late correction is picked up by recomputing, at a new rate too.
    await pastSale(end, 10000);
    await admin.post(`/royalty/${m}/compute`, { bp: 400 });
    expect((await month()).expenses[0]!.amount).toBe(14000);

    const royaltyExpense = (await month()).expenses[0]!;
    expect((await admin.send('PATCH', `/expenses/${royaltyExpense.id}`, { amount: 1 })).status).toBe(409);
    expect((await admin.post(`/royalty/${m}/confirm`)).status).toBe(200);
    expect((await month()).expenses[0]!.status).toBe('confirmed');
    expect((await admin.post(`/royalty/${m}/compute`)).status).toBe(409);
  });

  it('is drafted by the daily job along with recurring expenses, once', async () => {
    const admin = await loggedIn('super_admin');
    const db = drizzle(env.DB);
    expect(await monthlyJobs(db)).toEqual({ drafted: 1, royaltyMonth: lastMonth() });
    expect(await monthlyJobs(db)).toEqual({ drafted: 0, royaltyMonth: null });

    const { expenses } = await json<Month>(await admin.get(`/expenses?month=${thisMonth()}`));
    const bookkeeping = expenses.find((e) => e.recurringExpenseId === 'bookkeeping-monthly')!;
    expect(bookkeeping).toMatchObject({ categoryId: 'bookkeeping', amount: 125000, status: 'pending' });
    // A drafted bill can be changed, then confirmed when paid.
    expect((await admin.send('PATCH', `/expenses/${bookkeeping.id}`, { amount: 130000 })).status).toBe(200);
    expect((await admin.post(`/expenses/${bookkeeping.id}/confirm`)).status).toBe(200);
    // Drafting the month again on demand adds nothing.
    expect(await json(await admin.post('/expenses/recurring/draft', { month: thisMonth() }))).toEqual({ drafted: 0 });
  });
});

describe('expenses', () => {
  it('counts recorded Expenses, drawer Cash-outs and inventory purchases once each; pay is not spending', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    expect((await desk.post('/expenses', { categoryId: 'laundry', date: today(), amount: 35000, description: 'Towels' })).status).toBe(403);
    expect((await admin.post('/expenses', { categoryId: 'laundry', date: today(), amount: 35000, description: 'Towels' })).status).toBe(201);
    expect((await admin.post('/expenses', { categoryId: 'royalty', date: today(), amount: 100, description: 'Royalty' })).status).toBe(409);

    expect((await desk.post('/cash-outs', { category: 'food', amount: 12000, purpose: 'Rice for staff' })).status).toBe(201);
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO cash_outs (id, business_day, category, amount, purpose, created_at) VALUES (?, ?, 'on_call_commission', 30000, 'On-call pay', ?)`)
      .bind(crypto.randomUUID(), today(), now)
      .run();

    const { id: vendorId } = await json<{ id: string }>(await desk.post('/inventory/vendors', { name: `Market ${crypto.randomUUID().slice(0, 4)}` }));
    expect((await desk.post('/inventory/stock-ins', { itemId: 'alcohol', vendorId, qty: 2, unitPrice: 40000, purchaseDate: today(), fromDrawer: true })).status).toBe(201);
    expect((await desk.post('/inventory/stock-ins', { itemId: 'bleach', vendorId, qty: 1, unitPrice: 9000, purchaseDate: today() })).status).toBe(201);

    const m = await json<Month>(await admin.get(`/expenses?month=${thisMonth()}`));
    expect(m.cashOuts.map((x) => x.category)).toEqual(['food']);
    expect(m.purchases).toEqual(expect.arrayContaining([expect.objectContaining({ total: 80000, fromDrawer: true }), expect.objectContaining({ total: 9000, fromDrawer: false })]));
    expect(m.totals).toEqual({ confirmed: 35000, pending: 0, cashOuts: 12000, purchases: 89000 });

    // The purchase's Cash-out still leaves the drawer at Day Close, and can't be removed on its own.
    const { cashOuts } = await json<{ cashOuts: { id: string; category: string; amount: number }[] }>(await desk.get(`/cash-outs?day=${today()}`));
    const paid = cashOuts.find((x) => x.category === 'supplies')!;
    expect(paid.amount).toBe(80000);
    expect((await desk.send('DELETE', `/cash-outs/${paid.id}`)).status).toBe(409);
  });
});
