import { useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Field, FormPanel, Input, td, th } from '../../components/ui';
import { useRooms, useSave, type Room } from '../../lib/catalogue';

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

export function RoomsSettings() {
  const rooms = useRooms();
  const activeRooms = rooms.data?.rooms.filter((r) => r.active).length ?? 0;

  return (
    <div className="max-w-3xl">
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
    </div>
  );
}
