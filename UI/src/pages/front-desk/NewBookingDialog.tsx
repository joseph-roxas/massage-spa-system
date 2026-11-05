import { useState, type FormEvent } from 'react';
import { Alert, Button, Checkbox, Field, Input, Select } from '../../components/ui';
import { GuestPicker, guestBody, NO_GUEST, type GuestChoice } from '../../components/GuestPicker';
import { Modal } from '../../components/Modal';
import { fromLocalInput, useClockStaff } from '../../lib/attendance';
import { useServices } from '../../lib/catalogue';
import { duration, peso } from '../../lib/format';
import { fetchSuggestion, useDeskAction } from '../../lib/front-desk';

export function NewBookingDialog({
  kind,
  onClose,
  onNeedsAssignment,
}: {
  kind: 'walk_in' | 'scheduled';
  onClose: () => void;
  /** Called with the new walk-in when it could not be started automatically. */
  onNeedsAssignment: (bookingId: string) => void;
}) {
  const services = useServices();
  const staff = useClockStaff();
  const create = useDeskAction();
  const start = useDeskAction();
  const [guest, setGuest] = useState<GuestChoice>(NO_GUEST);
  const [form, setForm] = useState({
    serviceId: '',
    requestedTherapistId: '',
    scheduledAt: '',
    notes: '',
    startNow: true,
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const offered = services.data?.services.filter((s) => s.active) ?? [];
  const therapists = staff.data?.staff.filter((s) => s.kind === 'therapist') ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = {
      kind,
      serviceId: form.serviceId,
      ...guestBody(guest),
      requestedTherapistId: form.requestedTherapistId || null,
      notes: form.notes,
      ...(kind === 'scheduled' ? { scheduledAt: fromLocalInput(form.scheduledAt) } : {}),
    };
    const { id } = await create.mutateAsync({ path: '/bookings', body }).catch(() => ({ id: undefined }));
    if (!id) return;
    if (kind === 'scheduled' || !form.startNow) return onClose();

    // Start straight away when the suggestion is clear: a therapist and a room are free.
    const s = await fetchSuggestion(id);
    if (s.therapist && s.room) {
      await start
        .mutateAsync({ path: `/bookings/${id}/start`, body: { therapistId: s.therapist.staffId, roomId: s.room.roomId, flexMode: s.room.flexMode } })
        .then(onClose)
        .catch(() => onNeedsAssignment(id));
    } else {
      onNeedsAssignment(id);
    }
  }

  return (
    <Modal title={kind === 'walk_in' ? 'New walk-in' : 'Schedule a booking'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {(create.error || start.error) && <Alert>{(create.error ?? start.error)?.message}</Alert>}
        <Field label="Service">
          <Select required autoFocus value={form.serviceId} onChange={(e) => set('serviceId', e.target.value)}>
            <option value="">Choose a service…</option>
            <optgroup label="Services">
              {offered.filter((s) => s.kind === 'single').map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {duration(s.durationMin)} · {peso(s.currentPrice)}
                </option>
              ))}
            </optgroup>
            <optgroup label="Combos">
              {offered.filter((s) => s.kind === 'combo').map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} {s.name} · {duration(s.durationMin)} · {peso(s.currentPrice)}
                </option>
              ))}
            </optgroup>
          </Select>
        </Field>
        <GuestPicker value={guest} onChange={setGuest} nameLabel={kind === 'walk_in' ? 'Guest name (optional)' : 'Guest name'} required={kind === 'scheduled'} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Requested therapist" hint="Leave as Rotation unless the guest asks for someone">
            <Select value={form.requestedTherapistId} onChange={(e) => set('requestedTherapistId', e.target.value)}>
              <option value="">Next in Rotation</option>
              {therapists.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.displayName}
                  {t.clockedInAt ? '' : ' (not in yet)'}
                </option>
              ))}
            </Select>
          </Field>
          {kind === 'scheduled' && (
            <Field label="Date and time">
              <Input type="datetime-local" required value={form.scheduledAt} onChange={(e) => set('scheduledAt', e.target.value)} />
            </Field>
          )}
        </div>
        <Field label="Notes" hint="E.g. which add-on part of a combo, pressure, allergies">
          <Input value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
        {kind === 'walk_in' && (
          <Checkbox label="Start now if a therapist and room are free" checked={form.startNow} onChange={(e) => set('startNow', e.target.checked)} />
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={create.isPending || start.isPending}>
            {kind === 'scheduled' ? 'Save booking' : form.startNow ? 'Add and start' : 'Add to waiting list'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
