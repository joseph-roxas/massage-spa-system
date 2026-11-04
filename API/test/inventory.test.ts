import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { businessDayOf } from '@spa/domain';
import { loggedIn, type Client } from './helpers';

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type Item = {
  id: string;
  name: string;
  kind: string;
  storage: number;
  inTransit: number;
  shop: number;
  onHand: number;
  low: boolean;
  lastStockOut: string | null;
  latestPurchase: { unitPrice: number; vendorName: string } | null;
};
type Po = { id: string; status: string; lines: { id: string; itemId: string; qty: number; received: number }[] };

const today = () => businessDayOf(new Date());
const item = async (c: Client, id: string) => (await json<{ items: Item[] }>(await c.get('/inventory/items'))).items.find((i) => i.id === id)!;

let n = 0;
async function vendor(c: Client): Promise<string> {
  const res = await c.post('/inventory/vendors', { name: `Supplier ${++n} ${crypto.randomUUID().slice(0, 4)}` });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}

/** Bought by the Super Admin into Storage. */
async function bought(admin: Client, itemId: string, qty: number) {
  const res = await admin.post('/inventory/stock-ins', { itemId, vendorId: await vendor(admin), qty, unitPrice: 10000, purchaseDate: today() });
  expect(res.status).toBe(201);
}

async function sent(admin: Client, itemId: string, qty: number, takeoutRequestId?: string): Promise<string> {
  const res = await admin.post('/inventory/turnovers', { itemId, qty, sentOn: today(), takeoutRequestId });
  expect(res.status).toBe(201);
  return (await json<{ id: string }>(res)).id;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM turnovers`),
    env.DB.prepare(`DELETE FROM takeout_requests`),
    env.DB.prepare(`DELETE FROM stock_ins`),
    env.DB.prepare(`DELETE FROM stock_outs`),
    env.DB.prepare(`DELETE FROM purchase_order_lines`),
    env.DB.prepare(`DELETE FROM purchase_orders`),
  ]);
});

describe('purchase orders', () => {
  it('are the Super Admin’s: request → approve → receive in parts, into Storage', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const v = await vendor(admin);
    const body = {
      vendorId: v,
      lines: [
        { itemId: 'massage-oil', qty: 4, expectedPrice: 85000 },
        { itemId: 'tissue', qty: 24 },
      ],
    };
    expect((await desk.post('/inventory/purchase-orders', body)).status).toBe(403);
    expect((await desk.post('/inventory/vendors', { name: 'Market stall' })).status).toBe(403);
    const { id } = await json<{ id: string }>(await admin.post('/inventory/purchase-orders', body));
    const order = async () => (await json<{ purchaseOrders: Po[] }>(await admin.get('/inventory/purchase-orders'))).purchaseOrders.find((p) => p.id === id)!;
    const [oil, tissue] = (await order()).lines;

    const early = await admin.post(`/inventory/purchase-orders/${id}/receive`, { purchaseDate: today(), lines: [{ lineId: oil!.id, qty: 4, unitPrice: 85000 }] });
    expect(early.status).toBe(409);
    expect((await admin.post(`/inventory/purchase-orders/${id}/approve`)).status).toBe(200);

    const delivery = {
      purchaseDate: today(),
      lines: [
        { lineId: oil!.id, qty: 4, unitPrice: 87500 },
        { lineId: tissue!.id, qty: 12, unitPrice: 1500 },
      ],
    };
    expect((await desk.post(`/inventory/purchase-orders/${id}/receive`, delivery)).status).toBe(403);
    expect(await json(await admin.post(`/inventory/purchase-orders/${id}/receive`, delivery))).toMatchObject({ status: 'partially_received' });
    expect(await item(desk, 'massage-oil')).toMatchObject({ storage: 4, shop: 0, onHand: 0, latestPurchase: { unitPrice: 87500 } });

    const tooMany = await admin.post(`/inventory/purchase-orders/${id}/receive`, { purchaseDate: today(), lines: [{ lineId: tissue!.id, qty: 13, unitPrice: 1500 }] });
    expect(tooMany.status).toBe(400);
    const rest = await admin.post(`/inventory/purchase-orders/${id}/receive`, { purchaseDate: today(), lines: [{ lineId: tissue!.id, qty: 12, unitPrice: 1500 }] });
    expect(await json(rest)).toMatchObject({ status: 'received' });
    expect((await order()).lines.find((l) => l.itemId === 'tissue')!.received).toBe(24);
    expect((await admin.post(`/inventory/purchase-orders/${id}/cancel`, { reason: 'too late' })).status).toBe(409);
  });

  it('refuses the same item twice on one order', async () => {
    const admin = await loggedIn('super_admin');
    const v = await vendor(admin);
    const res = await admin.post('/inventory/purchase-orders', { vendorId: v, lines: [{ itemId: 'bleach', qty: 1 }, { itemId: 'bleach', qty: 2 }] });
    expect(res.status).toBe(400);
  });
});

describe('Storage, Turnovers and Shop Stock', () => {
  it('moves stock to the shop only once the Receptionist receives it; a shortfall stays in Storage', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    expect((await desk.post('/inventory/stock-ins', { itemId: 'alcohol', vendorId: 'x', qty: 1, unitPrice: 1, purchaseDate: today() })).status).toBe(403);
    await bought(admin, 'alcohol', 10);

    expect((await desk.post('/inventory/turnovers', { itemId: 'alcohol', qty: 3, sentOn: today() })).status).toBe(403);
    expect((await admin.post('/inventory/turnovers', { itemId: 'alcohol', qty: 11, sentOn: today() })).status).toBe(409);
    const t = await sent(admin, 'alcohol', 6);
    expect(await item(desk, 'alcohol')).toMatchObject({ storage: 4, inTransit: 6, shop: 0 });

    const { turnovers } = await json<{ turnovers: { id: string; receivedAt: string | null }[] }>(await desk.get('/inventory/turnovers'));
    expect(turnovers[0]).toMatchObject({ id: t, receivedAt: null });
    expect((await desk.post(`/inventory/turnovers/${t}/receive`, { receivedQty: 7 })).status).toBe(400);
    expect((await desk.post(`/inventory/turnovers/${t}/receive`, { receivedQty: 5 })).status).toBe(400); // short needs a note
    expect((await desk.post(`/inventory/turnovers/${t}/receive`, { receivedQty: 5, note: 'One bottle missing' })).status).toBe(200);
    expect((await desk.post(`/inventory/turnovers/${t}/receive`, { receivedQty: 5, note: 'again' })).status).toBe(409);
    expect(await item(desk, 'alcohol')).toMatchObject({ storage: 5, inTransit: 0, shop: 5, onHand: 5 });

    // The Super Admin finds the missing one was lost.
    expect((await desk.post(`/inventory/turnovers/${t}/resolve`, { outcome: 'lost' })).status).toBe(403);
    expect((await admin.post(`/inventory/turnovers/${t}/resolve`, { outcome: 'lost' })).status).toBe(200);
    expect((await admin.post(`/inventory/turnovers/${t}/resolve`, { outcome: 'lost' })).status).toBe(409);
    expect((await item(desk, 'alcohol')).storage).toBe(4);
  });

  it('answers a Take-out Request with a Turnover, closing it once received', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    await bought(admin, 'tissue', 20);
    expect((await desk.post('/inventory/takeout-requests', { qty: 2, level: 'low' })).status).toBe(400); // item or description
    const { id: req } = await json<{ id: string }>(await desk.post('/inventory/takeout-requests', { itemId: 'tissue', qty: 6, level: 'out', note: 'None left in rooms' }));
    const { id: newThing } = await json<{ id: string }>(await desk.post('/inventory/takeout-requests', { itemText: 'Bamboo baskets', qty: 3, level: 'out' }));

    const t = await sent(admin, 'tissue', 6, req);
    type Req = { id: string; resolvedAt: string | null; sent: number; itemName: string };
    const list = async () => (await json<{ requests: Req[] }>(await desk.get('/inventory/takeout-requests'))).requests;
    expect((await list()).find((r) => r.id === req)).toMatchObject({ resolvedAt: null, sent: 6 });
    expect((await list()).find((r) => r.id === newThing)).toMatchObject({ itemName: 'Bamboo baskets' });

    await desk.post(`/inventory/turnovers/${t}/receive`, { receivedQty: 6 });
    expect((await list()).find((r) => r.id === req)!.resolvedAt).not.toBeNull();
    expect((await desk.post(`/inventory/takeout-requests/${newThing}/dismiss`, { reason: 'Not needed' })).status).toBe(403);
    expect((await admin.post(`/inventory/takeout-requests/${newThing}/dismiss`, { reason: 'Bought elsewhere' })).status).toBe(200);
  });

  it('uses Consumables and discards the rest from Shop Stock, flagging low stock', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    await bought(admin, 'alcohol', 3);
    await desk.post(`/inventory/turnovers/${await sent(admin, 'alcohol', 3)}/receive`, { receivedQty: 3 });

    expect((await desk.post('/inventory/stock-outs', { itemId: 'alcohol', qty: 4 })).status).toBe(409);
    expect((await desk.post('/inventory/stock-outs', { itemId: 'alcohol', qty: 1, kind: 'discard', reason: 'broken' })).status).toBe(409);
    expect(await json(await desk.post('/inventory/stock-outs', { itemId: 'alcohol', qty: 2, note: 'Rooms 1–4' }))).toMatchObject({ onHand: 1 });
    // Reorder level is 1 gal.
    expect(await item(desk, 'alcohol')).toMatchObject({ shop: 1, low: true, lastStockOut: today() });

    const towel = `Bath towel ${crypto.randomUUID().slice(0, 4)}`;
    const { id: towels } = await json<{ id: string }>(await admin.post('/inventory/items', { name: towel, unit: 'pc', kind: 'reusable', reorderLevel: 0 }));
    await bought(admin, towels, 12);
    await desk.post(`/inventory/turnovers/${await sent(admin, towels, 10)}/receive`, { receivedQty: 10 });
    expect((await desk.post('/inventory/stock-outs', { itemId: towels, qty: 1 })).status).toBe(409); // not used up
    expect((await desk.post('/inventory/stock-outs', { itemId: towels, qty: 1, kind: 'discard' })).status).toBe(400); // needs a reason
    expect((await desk.post('/inventory/stock-outs', { itemId: towels, qty: 2, kind: 'discard', reason: 'worn_out' })).status).toBe(201);
    expect((await desk.post('/inventory/stock-outs', { itemId: towels, qty: 1, kind: 'discard', reason: 'lost', location: 'storage' })).status).toBe(403);
    expect((await admin.post('/inventory/stock-outs', { itemId: towels, qty: 1, kind: 'discard', reason: 'broken', location: 'storage' })).status).toBe(201);
    expect(await item(desk, towels)).toMatchObject({ kind: 'reusable', storage: 1, shop: 8 });

    const { moves } = await json<{ moves: { type: string; id: string; note: string | null }[] }>(await desk.get(`/inventory/items/${towels}/history`));
    expect(moves.map((m) => m.type).sort()).toEqual(['discard', 'discard', 'in', 'turnover']);
  });

  it('takes the go-live count of the Shop and of Storage from the Super Admin only', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const counts = { date: today(), counts: [{ itemId: 'dish-soap', qty: 2 }, { itemId: 'tissue', qty: 30 }] };
    expect((await desk.send('PUT', '/inventory/opening', counts)).status).toBe(403);
    expect((await admin.send('PUT', '/inventory/opening', counts)).status).toBe(200);
    expect((await admin.send('PUT', '/inventory/opening', { date: today(), counts: [{ itemId: 'tissue', qty: 28 }] })).status).toBe(200);
    expect((await admin.send('PUT', '/inventory/opening', { date: today(), location: 'storage', counts: [{ itemId: 'tissue', qty: 100 }] })).status).toBe(200);
    expect(await item(desk, 'tissue')).toMatchObject({ shop: 28, storage: 100, low: false });
    expect((await item(desk, 'dish-soap')).shop).toBe(2);
  });

  it('lets only the Super Admin add and edit Items', async () => {
    const admin = await loggedIn('super_admin');
    const desk = await loggedIn('receptionist');
    const body = { name: `Cotton pads ${crypto.randomUUID().slice(0, 4)}`, unit: 'pack of 100', reorderLevel: 2 };
    expect((await desk.post('/inventory/items', body)).status).toBe(403);
    const { id } = await json<{ id: string }>(await admin.post('/inventory/items', body));
    expect((await admin.post('/inventory/items', body)).status).toBe(409);
    expect((await admin.send('PATCH', `/inventory/items/${id}`, { reorderLevel: 5, kind: 'equipment' })).status).toBe(200);
    expect((await desk.send('PATCH', `/inventory/items/${id}`, { reorderLevel: 1 })).status).toBe(403);
    expect((await item(admin, id)).kind).toBe('equipment');
  });
});
