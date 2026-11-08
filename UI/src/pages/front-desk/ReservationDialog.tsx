import { useState, type FormEvent } from 'react';
import { Alert, Button, Checkbox, Field, Input, Select } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { fromLocalInput, toLocalInput, useClockStaff } from '../../lib/attendance';
import { useCurrentUser } from '../../lib/auth';
import { guestLabel, isNamedReservation, useDeskAction, type Booking } from '../../lib/front-desk';

export type ReservationChange = 'move' | 'cancel';

/** Moves or cancels a Booking. A named reservation changes only at the Guest's request, with a reason. */
export function ReservationDialog({ booking, mode, onClose }: { booking: Booking; mode: ReservationChange; onClose: () => void }) {
  const { data: me } = useCurrentUser();
  const staff = useClockStaff();
  const act = useDeskAction();
  const [at, setAt] = useState(booking.scheduledAt ? toLocalInput(booking.scheduledAt) : '');
  const [therapistId, setTherapistId] = useState(booking.requestedTherapistId ?? '');
  const [reason, setReason] = useState('');
  const [guestAsked, setGuestAsked] = useState(false);

  const named = isNamedReservation(booking);
  const mustAsk = named && me?.role !== 'super_admin';
  const needsReason = named || mode === 'cancel';
  const therapists = staff.data?.staff.filter((s) => s.kind === 'therapist') ?? [];

  function submit(e: FormEvent) {
    e.preventDefault();
    const answer = { reason, guestAsked };
    if (mode === 'cancel') {
      act.mutate({ path: `/bookings/${booking.id}/cancel`, body: answer }, { onSuccess: onClose });
      return;
    }
    const body = {
      ...(needsReason ? answer : {}),
      scheduledAt: fromLocalInput(at),
      requestedTherapistId: therapistId || null,
    };
    act.mutate({ path: `/bookings/${booking.id}`, method: 'PATCH', body }, { onSuccess: onClose });
  }

  return (
    <Modal title={`${mode === 'move' ? 'Move' : 'Cancel'} booking · ${guestLabel(booking)}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {act.error && <Alert>{act.error.message}</Alert>}
        {named && (
          <p className="text-sm text-stone-600">
            {booking.requestedTherapistName} is reserved for this guest. It can only be changed if the guest asks.
          </p>
        )}
        {mode === 'move' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date and time">
              <Input type="datetime-local" required value={at} onChange={(e) => setAt(e.target.value)} />
            </Field>
            <Field label="Requested therapist">
              <Select value={therapistId} onChange={(e) => setTherapistId(e.target.value)}>
                <option value="">Next in Rotation</option>
                {therapists.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.displayName}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        {needsReason && (
          <Field label="Reason" hint="Kept in the audit log">
            <Input required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
        {mustAsk && <Checkbox label="The guest asked for this" checked={guestAsked} onChange={(e) => setGuestAsked(e.target.checked)} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Go back</Button>
          <Button type="submit" disabled={act.isPending || (mustAsk && !guestAsked)}>{mode === 'move' ? 'Save' : 'Cancel booking'}</Button>
        </div>
      </form>
    </Modal>
  );
}
