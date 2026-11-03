import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Field, Input, Select } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useServices } from '../../lib/catalogue';
import { duration } from '../../lib/format';
import { fetchSuggestion, guestLabel, useDeskAction, type Board, type Booking } from '../../lib/front-desk';

export function StartDialog({ booking, board, onClose }: { booking: Booking; board: Board; onClose: () => void }) {
  const suggestion = useQuery({ queryKey: ['suggest', booking.id], queryFn: () => fetchSuggestion(booking.id), staleTime: 0 });
  const services = useServices();
  const start = useDeskAction();
  const [therapistId, setTherapistId] = useState('');
  const [roomId, setRoomId] = useState('');
  const [flexMode, setFlexMode] = useState<'floor' | 'recliner'>('floor');
  const [portableTable, setPortableTable] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  // Pre-fill with the suggestion once it arrives.
  const s = suggestion.data;
  useEffect(() => {
    if (!s) return;
    /* eslint-disable react-hooks/set-state-in-effect -- one-time prefill from the server's suggestion */
    if (s.therapist) setTherapistId(s.therapist.staffId);
    if (s.room) {
      setRoomId(String(s.room.roomId));
      if (s.room.flexMode) setFlexMode(s.room.flexMode);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [s]);

  const service = services.data?.services.find((x) => x.id === booking.serviceId);
  const room = board.rooms.find((r) => String(r.id) === roomId);
  const overriding = !!therapistId && s?.therapist?.staffId !== therapistId;
  const freeRooms = board.rooms.filter((r) => r.active && !r.booking);

  function submit(e: FormEvent) {
    e.preventDefault();
    start.mutate(
      {
        path: `/bookings/${booking.id}/start`,
        body: {
          therapistId,
          roomId: Number(roomId),
          flexMode: room?.isFlex ? flexMode : null,
          portableTable,
          overrideReason: overriding ? overrideReason : undefined,
        },
      },
      { onSuccess: onClose },
    );
  }

  return (
    <Modal title={`Start · ${guestLabel(booking)}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-stone-600">
          {booking.serviceName} · {duration(booking.durationMin)}
          {booking.requestedTherapistName && <> · asked for <strong>{booking.requestedTherapistName}</strong></>}
        </p>
        {start.error && <Alert>{start.error.message}</Alert>}
        {s && !s.therapist && (
          <Alert tone="info">
            {booking.requestedTherapistName
              ? `${booking.requestedTherapistName} is not free right now. The guest can wait, or pick someone else with a reason.`
              : 'No therapist is free right now.'}
          </Alert>
        )}
        {s && !s.room && <Alert tone="info">All rooms are taken.</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Therapist">
            <Select required value={therapistId} onChange={(e) => setTherapistId(e.target.value)}>
              <option value="">Choose…</option>
              {board.rotation.map((r) => (
                <option key={r.staffId} value={r.staffId} disabled={r.status !== 'free'}>
                  {r.position}. {r.displayName}
                  {s?.therapist?.staffId === r.staffId ? (s.therapist.reason === 'requested' ? ' (requested)' : ' (next)') : ''}
                  {r.status !== 'free' ? ' (with a guest)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Room">
            <Select required value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              <option value="">Choose…</option>
              {freeRooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {room?.isFlex && (
          <fieldset className="flex gap-6 text-sm">
            <legend className="mb-1 font-medium text-stone-700">Set up {room.name} as</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="flex" checked={flexMode === 'floor'} onChange={() => setFlexMode('floor')} /> Floor bed
            </label>
            <label className={`flex items-center gap-2 ${service?.isFootType ? '' : 'text-stone-400'}`}>
              <input type="radio" name="flex" disabled={!service?.isFootType} checked={flexMode === 'recliner'} onChange={() => setFlexMode('recliner')} />
              Foot recliner {service?.isFootType ? '' : '(foot services only)'}
            </label>
          </fieldset>
        )}
        <Checkbox label="Guest asked for the portable table" checked={portableTable} onChange={(e) => setPortableTable(e.target.checked)} />
        {overriding && (
          <Field label="Why not the suggested therapist?" hint="Kept in the audit log">
            <Input required minLength={3} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
          </Field>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Not yet</Button>
          <Button type="submit" disabled={start.isPending || !therapistId || !roomId}>Start service</Button>
        </div>
      </form>
    </Modal>
  );
}
