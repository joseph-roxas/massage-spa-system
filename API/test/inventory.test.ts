import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { businessDayOf } from '@spa/domain';
import { loggedIn, type Client } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type Item = { id: string; name: string; onHand: number; low: boolean; lastStockOut: string | null; latestPurchase: { unitPrice: number; vendorName: string } | null };
type Po = { id: string; status: string; lines: { id: string; itemId: string; qty: number; received: number }[] };

const today = () => businessDayOf(new Date());
const item = async (c: Client, id: string) => (await json<{ items: Item[] }>(await c.get('/inventory/items'))).items.find((i) => i.id === id)!;

let n = 0;
async function vendor(c: Client): Promise<string> {
  const res = await c.post('/inventory/vendors', { name: `Supplier ${++n} ${crypto.randomUUID().slice(0, 4)}` });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM stock_ins`),
    env.DB.prepare(`DELETE FROM stock_outs`),
    env.DB.prepare(`DELETE FROM purchase_order_lines`),
    env.DB.prepare(`DELETE FROM purchase_orders`),
  ]);
});

describe('purchase orders', () => {
  it('runs request → approve → receive in parts, updating on hand', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const v = await vendor(desk);

    const res = await desk.post('/inventory/purchase-orders', {
      vendorId: v,
      lines: [
        { itemId: 'massage-oil', qty: 4, expectedPrice: 85000 },
        { itemId: 'tissue', qty: 24 },
      ],
    });
    expect(res.status).toBe(201);
    const { id } = await json<{ id: string }>(res);
    const order = async () => (await json<{ purchaseOrders: Po[] }>(await desk.get('/inventory/purchase-orders'))).purchaseOrders.find((p) => p.id === id)!;
    const [oil, tissue] = (await order()).lines;

    // Not before approval, and only the Super Admin approves.
    const early = await desk.post(`/inventory/purchase-orders/${id}/receive`, { purchaseDate: today(), lines: [{ lineId: oil!.id, qty: 4, unitPrice: 85000 }] });
    expect(early.status).toBe(409);
    expect((await desk.post(`/inventory/purchase-orders/${id}/approve`)).status).toBe(403);
    expect((await admin.post(`/inventory/purchase-orders/${id}/approve`)).status).toBe(200);

    const first = await desk.post(`/inventory/purchase-orders/${id}/receive`, {
      purchaseDate: today(),
      lines: [
        { lineId: oil!.id, qty: 4, unitPrice: 87500 },
        { lineId: tissue!.id, qty: 12, unitPrice: 1500 },
      ],
    });
    expect(await json(first)).toMatchObject({ status: 'partially_received' });
    expect(await item(desk, 'massage-oil')).toMatchObject({ onHand: 4, latestPurchase: { unitPrice: 87500 } });

    const tooMany = await desk.post(`/inventory/purchase-orders/${id}/receive`, { purchaseDate: today(), lines: [{ lineId: tissue!.id, qty: 13, unitPrice: 1500 }] });
    expect(tooMany.status).toBe(400);
    const rest = await desk.post(`/inventory/purchase-orders/${id}/receive`, { purchaseDate: today(), lines: [{ lineId: tissue!.id, qty: 12, unitPrice: 1500 }] });
    expect(await json(rest)).toMatchObject({ status: 'received' });
    expect((await order()).lines.find((l) => l.itemId === 'tissue')!.received).toBe(24);
    expect((await admin.post(`/inventory/purchase-orders/${id}/cancel`, { reason: 'too late' })).status).toBe(409);
  });

  it('lets the requester withdraw a request, and only the Super Admin cancel an approved one', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const v = await vendor(desk);
    const make = async () => (await json<{ id: string }>(await desk.post('/inventory/purchase-orders', { vendorId: v, lines: [{ itemId: 'bleach', qty: 1 }] }))).id;

    expect((await desk.post(`/inventory/purchase-orders/${await make()}/cancel`, { reason: 'ordered by phone' })).status).toBe(200);
    const approved = await make();
    await admin.post(`/inventory/purchase-orders/${approved}/approve`);
    expect((await desk.post(`/inventory/purchase-orders/${approved}/cancel`, { reason: 'changed my mind' })).status).toBe(403);
    expect((await admin.post(`/inventory/purchase-orders/${approved}/cancel`, { reason: 'vendor out of stock' })).status).toBe(200);
  });

  it('refuses the same item twice on one order', async () => {
    const desk = await loggedIn('receptionist');
    const v = await vendor(desk);
    const res = await desk.post('/inventory/purchase-orders', { vendorId: v, lines: [{ itemId: 'bleach', qty: 1 }, { itemId: 'bleach', qty: 2 }] });
    expect(res.status).toBe(400);
  });
});

describe('stock', () => {
  it('takes out no more than is on hand, flags low stock and remembers the last stock-out', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const v = await vendor(desk);
    // Bought at the market, without an order.
    expect((await desk.post('/inventory/stock-ins', { itemId: 'alcohol', vendorId: v, qty: 3, unitPrice: 42000, purchaseDate: today() })).status).toBe(201);

    expect((await desk.post('/inventory/stock-outs', { itemId: 'alcohol', qty: 4 })).status).toBe(409);
    const out = await desk.post('/inventory/stock-outs', { itemId: 'alcohol', qty: 2, note: 'Rooms 1–4' });
    expect(await json(out)).toMatchObject({ onHand: 1 });
    // Reorder level is 1 gal.
    expect(await item(desk, 'alcohol')).toMatchObject({ onHand: 1, low: true, lastStockOut: today() });

    const { moves } = await json<{ moves: { type: string; id: string; qty: number }[] }>(await desk.get('/inventory/items/alcohol/history'));
    expect(moves.map((m) => m.type).sort()).toEqual(['in', 'out']);
    expect((await desk.send('DELETE', `/inventory/stock-outs/${moves.find((m) => m.type === 'out')!.id}`)).status).toBe(200);
    expect((await item(admin, 'alcohol')).onHand).toBe(3);
  });

  it('takes the go-live count from the Super Admin only, replacing an earlier count', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const counts = { date: today(), counts: [{ itemId: 'dish-soap', qty: 2 }, { itemId: 'tissue', qty: 30 }] };
    expect((await desk.send('PUT', '/inventory/opening', counts)).status).toBe(403);
    expect((await admin.send('PUT', '/inventory/opening', counts)).status).toBe(200);
    expect((await admin.send('PUT', '/inventory/opening', { date: today(), counts: [{ itemId: 'tissue', qty: 28 }] })).status).toBe(200);
    expect(await item(desk, 'tissue')).toMatchObject({ onHand: 28, low: false });
    expect((await item(desk, 'dish-soap')).onHand).toBe(2);
  });

  it('lets only the Super Admin add and edit Items', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const body = { name: `Cotton pads ${crypto.randomUUID().slice(0, 4)}`, unit: 'pack of 100', reorderLevel: 2 };
    expect((await desk.post('/inventory/items', body)).status).toBe(403);
    const { id } = await json<{ id: string }>(await admin.post('/inventory/items', body));
    expect((await admin.post('/inventory/items', body)).status).toBe(409);
    expect((await admin.send('PATCH', `/inventory/items/${id}`, { reorderLevel: 5 })).status).toBe(200);
    expect((await desk.send('PATCH', `/inventory/items/${id}`, { reorderLevel: 1 })).status).toBe(403);
  });
});
