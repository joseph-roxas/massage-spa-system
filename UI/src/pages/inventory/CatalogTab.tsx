import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Field, FormPanel, Input, Select, td, th } from '../../components/ui';
import { todayManila } from '../../lib/format';
import { useCan } from '../../lib/auth';
import { OpeningUpload } from './OpeningUpload';
import { ITEM_KIND_LABELS, itemLabel, useInventoryAction, useItems, useVendors, type Item, type ItemKind, type Vendor } from '../../lib/inventory';

function ItemForm({ item, onDone }: { item?: Item; onDone: () => void }) {
  const act = useInventoryAction();
  const [d, setD] = useState({
    name: item?.name ?? '',
    unit: item?.unit ?? '',
    kind: item?.kind ?? ('consumable' as ItemKind),
    reorderLevel: String(item?.reorderLevel ?? 0),
    active: item?.active ?? true,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const body = { name: d.name, unit: d.unit, kind: d.kind, reorderLevel: Number(d.reorderLevel), active: d.active };
    act.mutate(item ? { path: `/inventory/items/${item.id}`, method: 'PATCH', body } : { path: '/inventory/items', body }, { onSuccess: onDone });
  }

  return (
    <FormPanel onSubmit={submit}>
      {act.error && <Alert>{act.error.message}</Alert>}
      <div className="grid grid-cols-[1fr_10rem_11rem_8rem] gap-3">
        <Field label="Item">
          <Input required value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="E.g. Massage oil" />
        </Field>
        <Field label="Unit">
          <Input required value={d.unit} onChange={(e) => setD({ ...d, unit: e.target.value })} placeholder="gal, roll, pack of 50" />
        </Field>
        <Field label="Kind" hint={d.kind === 'consumable' ? 'Used up' : 'Discarded when broken or worn out'}>
          <Select value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as ItemKind })}>
            {Object.entries(ITEM_KIND_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Low at the shop at" hint="0 = no warning">
          <Input inputMode="numeric" required value={d.reorderLevel} onChange={(e) => setD({ ...d, reorderLevel: e.target.value })} />
        </Field>
      </div>
      {item && <Checkbox label="Still stocked" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} />}
      <div className="flex gap-2">
        <Button type="submit" disabled={act.isPending || !Number.isInteger(Number(d.reorderLevel))}>Save</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </FormPanel>
  );
}

function VendorForm({ vendor, onDone }: { vendor?: Vendor; onDone: () => void }) {
  const act = useInventoryAction();
  const [d, setD] = useState({ name: vendor?.name ?? '', contact: vendor?.contact ?? '', active: vendor?.active ?? true });
  return (
    <FormPanel
      onSubmit={(e) => {
        e.preventDefault();
        act.mutate(vendor ? { path: `/inventory/vendors/${vendor.id}`, method: 'PATCH', body: d } : { path: '/inventory/vendors', body: d }, { onSuccess: onDone });
      }}
    >
      {act.error && <Alert>{act.error.message}</Alert>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Vendor">
          <Input required value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
        </Field>
        <Field label="Contact (optional)">
          <Input value={d.contact} onChange={(e) => setD({ ...d, contact: e.target.value })} placeholder="Phone, address, Facebook page" />
        </Field>
      </div>
      {vendor && <Checkbox label="Still buying from them" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} />}
      <div className="flex gap-2">
        <Button type="submit" disabled={act.isPending}>Save</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </FormPanel>
  );
}

/** Go-live: what is on the shelves today. */
function OpeningCount({ items, onDone }: { items: Item[]; onDone: () => void }) {
  const act = useInventoryAction();
  const [date, setDate] = useState(todayManila());
  const [location, setLocation] = useState<'shop' | 'storage'>('shop');
  const [counts, setCounts] = useState<Record<string, string>>({});
  const entered = Object.entries(counts).filter(([, v]) => v.trim() !== '');
  const valid = entered.length > 0 && entered.every(([, v]) => Number.isInteger(Number(v)) && Number(v) >= 0);

  return (
    <FormPanel
      onSubmit={(e) => {
        e.preventDefault();
        act.mutate({ path: '/inventory/opening', method: 'PUT', body: { date, location, counts: entered.map(([itemId, v]) => ({ itemId, qty: Number(v) })) } }, { onSuccess: onDone });
      }}
    >
      {act.error && <Alert>{act.error.message}</Alert>}
      <p className="text-sm text-stone-600">
        Count what is at the shop and what is in your storage, once, when you start using the system. Entering an item again replaces its count there. Leave blank to skip.
      </p>
      <div className="flex gap-3">
        <Field label="Where">
          <Select value={location} onChange={(e) => setLocation(e.target.value as 'shop' | 'storage')}>
            <option value="shop">At the shop</option>
            <option value="storage">In my storage</option>
          </Select>
        </Field>
        <Field label="Counted on">
          <Input type="date" required max={todayManila()} value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2">
        {items
          .filter((i) => i.active)
          .map((i) => (
            <label key={i.id} className="flex items-center justify-between gap-3 text-sm">
              <span>{itemLabel(i)}</span>
              <Input inputMode="numeric" className="w-20" value={counts[i.id] ?? ''} onChange={(e) => setCounts({ ...counts, [i.id]: e.target.value })} />
            </label>
          ))}
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={!valid || act.isPending}>Save count ({entered.length})</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </FormPanel>
  );
}

export function CatalogTab() {
  const items = useItems();
  const vendors = useVendors();
  const [editItem, setEditItem] = useState<Item | 'new' | null>(null);
  const [editVendor, setEditVendor] = useState<Vendor | 'new' | null>(null);
  const [counting, setCounting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const canCount = useCan('inventory.po.approve');

  return (
    <div className="space-y-6">
      <Card
        title="Items"
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setCounting(true)}>Opening count</Button>
            {canCount && (
              <Button variant="secondary" onClick={() => setUploading(true)}>Upload opening count</Button>
            )}
            <Button onClick={() => setEditItem('new')}>Add item</Button>
          </div>
        }
      >
        {counting && (
          <div className="mb-4">
            <OpeningCount items={items.data?.items ?? []} onDone={() => setCounting(false)} />
          </div>
        )}
        {uploading && (
          <div className="mb-4">
            <OpeningUpload items={items.data?.items ?? []} onDone={() => setUploading(false)} />
          </div>
        )}
        {editItem === 'new' && (
          <div className="mb-4">
            <ItemForm onDone={() => setEditItem(null)} />
          </div>
        )}
        <table className="w-full">
          <thead>
            <tr className="border-b border-stone-200">
              <th className={th}>Item</th>
              <th className={th}>Unit</th>
              <th className={th}>Kind</th>
              <th className={`${th} text-right`}>Low at</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {items.data?.items.map((i) =>
              editItem !== 'new' && editItem?.id === i.id ? (
                <tr key={i.id}>
                  <td colSpan={5} className="py-2">
                    <ItemForm item={i} onDone={() => setEditItem(null)} />
                  </td>
                </tr>
              ) : (
                <tr key={i.id} className={i.active ? '' : 'text-stone-400'}>
                  <td className={td}>
                    {i.name} {!i.active && <Badge>Not stocked</Badge>}
                  </td>
                  <td className={td}>{i.unit}</td>
                  <td className={td}>{ITEM_KIND_LABELS[i.kind]}</td>
                  <td className={`${td} text-right tabular-nums`}>{i.reorderLevel || '—'}</td>
                  <td className={`${td} text-right`}>
                    <button type="button" className="text-sm text-teal-800 underline" onClick={() => setEditItem(i)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </Card>

      <Card title="Vendors" actions={<Button onClick={() => setEditVendor('new')}>Add vendor</Button>}>
        {editVendor === 'new' && (
          <div className="mb-4">
            <VendorForm onDone={() => setEditVendor(null)} />
          </div>
        )}
        {vendors.data?.vendors.length === 0 && editVendor !== 'new' && <p className="text-sm text-stone-500">No vendors yet.</p>}
        <ul className="divide-y divide-stone-100">
          {vendors.data?.vendors.map((v) =>
            editVendor !== 'new' && editVendor?.id === v.id ? (
              <li key={v.id} className="py-2">
                <VendorForm vendor={v} onDone={() => setEditVendor(null)} />
              </li>
            ) : (
              <li key={v.id} className={`flex items-center gap-3 py-2 text-sm ${v.active ? '' : 'text-stone-400'}`}>
                <span className="font-medium">{v.name}</span>
                {v.contact && <span className="text-stone-500">{v.contact}</span>}
                {!v.active && <Badge>Not used</Badge>}
                <span className="flex-1" />
                <button type="button" className="text-teal-800 underline" onClick={() => setEditVendor(v)}>
                  Edit
                </button>
              </li>
            ),
          )}
        </ul>
      </Card>
    </div>
  );
}
