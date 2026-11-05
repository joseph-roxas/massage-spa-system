import { useState, type FormEvent } from 'react';
import { Alert, Button, Field, Select } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { ApiError } from '../../lib/api';
import { useClockStaff } from '../../lib/attendance';
import { useServices } from '../../lib/catalogue';
import { duration, peso } from '../../lib/format';
import { guestLabel, useDeskAction, type Booking } from '../../lib/front-desk';

/**
 * An Added Service: the Guest asks for another Service partway through. It
 * follows in the same Room, by default with the same Therapist, and starts by
 * itself once the current one is done.
 */
export function AddServiceDialog({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  const services = useServices();
  const staff = useClockStaff();
  const add = useDeskAction();
  const [serviceId, setServiceId] = useState('');
  const [therapistId, setTherapistId] = useState(booking.therapistId ?? '');
  const clash = add.error instanceof ApiError && add.error.code === 'clash' ? add.error.message : null;

  // The recliner only takes foot services.
  const offered = (services.data?.services ?? []).filter((s) => s.active && (booking.flexMode !== 'recliner' || s.isFootType));
  const therapists = (staff.data?.staff ?? []).filter((s) => s.kind === 'therapist' && (s.clockedInAt || s.id === booking.therapistId));

  function send(confirm: boolean) {
    add.mutate({ path: `/bookings/${booking.id}/add-service`, body: { serviceId, therapistId, confirm } }, { onSuccess: onClose });
  }

  return (
    <Modal title={`Add a service · ${guestLabel(booking)}`} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          send(false);
        }}
      >
        <p className="text-sm text-stone-600">
          Follows {booking.serviceName} in the same room and starts when it is done. Paid together at checkout.
        </p>
        {add.error && !clash && <Alert>{add.error.message}</Alert>}
        <Field label="Service">
          <Select required autoFocus value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
            <option value="">Choose a service…</option>
            {offered.map((s) => (
              <option key={s.id} value={s.id}>
                {s.kind === 'combo' ? `${s.code} ` : ''}
                {s.name} · {duration(s.durationMin)} · {peso(s.currentPrice)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Therapist" hint="The same therapist unless someone else takes over">
          <Select value={therapistId} onChange={(e) => setTherapistId(e.target.value)}>
            {therapists.map((t) => (
              <option key={t.id} value={t.id}>
                {t.displayName}
                {t.id === booking.therapistId ? ' (same)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        {clash && (
          <Alert tone="info">
            <span className="flex items-center justify-between gap-3">
              <span>{clash}</span>
              <Button type="button" className="h-8 shrink-0 px-3" disabled={add.isPending} onClick={() => send(true)}>
                Add anyway
              </Button>
            </span>
          </Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!serviceId || add.isPending}>Add service</Button>
        </div>
      </form>
    </Modal>
  );
}
