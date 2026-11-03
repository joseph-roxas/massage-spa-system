import { useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Field, FormPanel, Input, td, th } from '../../components/ui';
import { useAddons, useRooms, useSave, type Addon, type Room } from '../../lib/catalogue';
import { parsePesos, peso, pesosText } from '../../lib/format';

function RoomRow({ room }: { room: Room }) {
  const [editing, setEditing] = useState(false);
  const [d, setD] = useState(room);
  const save = useSave(({ id, ...body }: Room) => ({ path: `/catalogue/rooms/${id}`, method: 'PUT', body }), 'catalogue');

  if (!editing) {
    return (
      <tr className={room.active ? '' : 'opacity-50'}>
        <td className={td}>{room.name}</td>
        <td className={td}>{room.isFlex ? <Badge tone="teal">Floor bed or foot recliner</Badge> : 'Floor bed'}</td>
        <td className={td}>{room.active ? 'In use' : <Badge tone="red">Closed</Badge>}</td>
        <td className={`${td} text-right`}>
          <Button variant="secondary" className="h-8 px-3" onClick={() => { setD(room); setEditing(true); }}>Edit</Button>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td colSpan={4} className="py-2">
        <FormPanel onSubmit={(e) => { e.preventDefault(); save.mutate(d, { onSuccess: () => setEditing(false) }); }}>
          {save.error && <Alert>{save.error.message}</Alert>}
          <div className="flex items-end gap-4">
            <div className="w-56">
              <Field label="Name">
                <Input required value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
              </Field>
            </div>
            <Checkbox label="Flex Room" checked={d.isFlex} onChange={(e) => setD({ ...d, isFlex: e.target.checked })} />
            <Checkbox label="In use" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} />
            <Button type="submit" disabled={save.isPending}>Save</Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </FormPanel>
      </td>
    </tr>
  );
}

function AddonForm({ addon, onDone }: { addon?: Addon; onDone: () => void }) {
  const [name, setName] = useState(addon?.name ?? '');
  const [price, setPrice] = useState(addon ? pesosText(addon.price) : '');
  const [active, setActive] = useState(addon?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const save = useSave(
    (body: Omit<Addon, 'id'>) => (addon ? { path: `/catalogue/addons/${addon.id}`, method: 'PUT', body } : { path: '/catalogue/addons', body }),
    'catalogue',
  );

  function submit(e: FormEvent) {
    e.preventDefault();
    const cents = parsePesos(price);
    if (cents === null) return setError('Enter a peso amount.');
    setError(null);
    save.mutate({ name, price: cents, active }, { onSuccess: onDone });
  }

  return (
    <FormPanel onSubmit={submit}>
      {(error || save.error) && <Alert>{error ?? save.error?.message}</Alert>}
      <div className="flex items-end gap-4">
        <div className="w-56">
          <Field label="Add-on">
            <Input required value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <div className="w-32">
          <Field label="Price (₱)">
            <Input inputMode="decimal" required value={price} onChange={(e) => setPrice(e.target.value)} />
          </Field>
        </div>
        <Checkbox label="Offered" checked={active} onChange={(e) => setActive(e.target.checked)} />
        <Button type="submit" disabled={save.isPending}>Save</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </FormPanel>
  );
}

export function RoomsSettings() {
  const rooms = useRooms();
  const addons = useAddons();
  const [editingAddon, setEditingAddon] = useState<string | 'new' | null>(null);
  const activeRooms = rooms.data?.rooms.filter((r) => r.active).length ?? 0;

  return (
    <div className="grid grid-cols-2 gap-6">
      <Card title={`Rooms (${activeRooms} in use)`}>
        <p className="mb-3 text-sm text-stone-500">Each room takes one guest at a time.</p>
        <table className="w-full">
          <thead>
            <tr className="border-b border-stone-200">
              <th className={th}>Room</th>
              <th className={th}>Setup</th>
              <th className={th}>Status</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {rooms.data?.rooms.map((r) => <RoomRow key={r.id} room={r} />)}
          </tbody>
        </table>
      </Card>
      <Card title="Add-ons" actions={editingAddon !== 'new' && <Button onClick={() => setEditingAddon('new')}>Add</Button>}>
        <p className="mb-3 text-sm text-stone-500">Add-ons go wholly to the shop: no commission, not in royalty sales.</p>
        {editingAddon === 'new' && (
          <div className="mb-3">
            <AddonForm onDone={() => setEditingAddon(null)} />
          </div>
        )}
        <ul className="divide-y divide-stone-100">
          {addons.data?.addons.map((a) =>
            editingAddon === a.id ? (
              <li key={a.id} className="py-2">
                <AddonForm addon={a} onDone={() => setEditingAddon(null)} />
              </li>
            ) : (
              <li key={a.id} className={`flex items-center justify-between py-2 text-sm ${a.active ? '' : 'opacity-50'}`}>
                <span>{a.name}</span>
                <span className="flex items-center gap-3">
                  <span className="font-semibold tabular-nums">{peso(a.price)}</span>
                  <Button variant="secondary" className="h-8 px-3" onClick={() => setEditingAddon(a.id)}>Edit</Button>
                </span>
              </li>
            ),
          )}
        </ul>
      </Card>
    </div>
  );
}
