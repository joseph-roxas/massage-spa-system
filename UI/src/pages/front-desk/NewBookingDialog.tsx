import { useState, type FormEvent } from 'react';
import { businessDayOf, onBusinessDay, TOP_UP_PARTS, TOP_UP_STEP_MIN, topUpHourService, topUpPrice, topUpRule, topUpTotal, type Centavos, type TopUpPart } from '@spa/domain';
import { Alert, Button, Checkbox, Field, Input, Select } from '../../components/ui';
import { GuestPicker, guestBody, NO_GUEST, type GuestChoice } from '../../components/GuestPicker';
import { Modal } from '../../components/Modal';
import { fromLocalInput, useClockStaff } from '../../lib/attendance';
import { useRooms, useServices } from '../../lib/catalogue';
import { duration, peso } from '../../lib/format';
import { fetchSuggestion, useDeskAction } from '../../lib/front-desk';

/** Up to three more hours from the booking form; a longer stay can still be topped up during the Service. */
const MAX_EXTRA_STEPS = 6;

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
    extraSteps: 0,
    topUpPart: '' as '' | TopUpPart,
    // A Late Entry: the Therapist served the guest before the desk could record it.
    late: false,
    therapistId: '',
    requested: false,
    roomId: '',
    flexMode: 'floor' as 'floor' | 'recliner',
    startedAt: '',
    finishedAt: '',
  });
  const rooms = useRooms();
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const offered = services.data?.services.filter((s) => s.active) ?? [];
  const therapists = staff.data?.staff.filter((s) => s.kind === 'therapist') ?? [];
  const service = offered.find((s) => s.id === form.serviceId);
  const rule = service ? topUpRule(service) : null;
  const picking = rule?.kind === 'pick_part' && form.extraSteps > 0;
  const priceOf = (id: string) => (services.data?.services.find((s) => s.id === id)?.currentPrice ?? undefined) as Centavos | undefined;
  /** One 30-minute step, once it is known. */
  const stepPrice = (part: TopUpPart | null) => (service && rule ? topUpPrice(rule, (service.currentPrice ?? 0) as Centavos, part, priceOf) : null);
  /** All the extra time, each full hour at its 1-hour price where there is one. */
  const extraPrice = (part: TopUpPart | null) => {
    const each = stepPrice(part);
    if (each === null || !rule) return null;
    const hourService = topUpHourService(rule, part);
    return topUpTotal(form.extraSteps, each, hourService ? (priceOf(hourService) ?? null) : null);
  };
  const extra = extraPrice(form.topUpPart || null);
  const lengths = service && rule ? Array.from({ length: MAX_EXTRA_STEPS + 1 }, (_, i) => i) : [];

  const late = kind === 'walk_in' && form.late;
  const lateRoom = rooms.data?.rooms.find((r) => String(r.id) === form.roomId);
  /** A time today, as typed on the form; before 6:00am is after midnight, still today's Business Day. */
  const todayAt = (hhmm: string) => onBusinessDay(businessDayOf(new Date()), hhmm).toISOString();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (late) {
      const body = {
        serviceId: form.serviceId,
        ...guestBody(guest),
        notes: form.notes,
        extraSteps: form.extraSteps,
        topUpPart: form.topUpPart || null,
        therapistId: form.therapistId,
        requested: form.requested,
        roomId: Number(form.roomId),
        flexMode: lateRoom?.isFlex ? form.flexMode : null,
        startedAt: todayAt(form.startedAt),
        finishedAt: form.finishedAt ? todayAt(form.finishedAt) : null,
      };
      const { id } = await create.mutateAsync({ path: '/bookings/late', body }).catch(() => ({ id: undefined }));
      if (id) onClose();
      return;
    }
    const body = {
      kind,
      serviceId: form.serviceId,
      ...guestBody(guest),
      requestedTherapistId: form.requestedTherapistId || null,
      notes: form.notes,
      extraSteps: form.extraSteps,
      topUpPart: form.topUpPart || null,
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
          <Select required autoFocus value={form.serviceId} onChange={(e) => setForm((f) => ({ ...f, serviceId: e.target.value, extraSteps: 0, topUpPart: '' }))}>
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
        {lengths.length > 0 && service && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="How long" hint={form.extraSteps > 0 && extra !== null ? `${peso((service.currentPrice ?? 0) + extra)} in all` : 'The menu time unless the guest asks for longer'}>
              <Select value={form.extraSteps} onChange={(e) => set('extraSteps', Number(e.target.value))}>
                {lengths.map((i) => (
                  <option key={i} value={i}>
                    {duration(service.durationMin + i * TOP_UP_STEP_MIN)}
                    {i === 0 ? ' (menu)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            {picking && (
              <Field label="Extra time is">
                <Select required value={form.topUpPart} onChange={(e) => set('topUpPart', e.target.value as TopUpPart)}>
                  <option value="">Choose…</option>
                  {TOP_UP_PARTS.map((p) => (
                    <option key={p} value={p}>
                      {p[0]!.toUpperCase() + p.slice(1)} massage · {peso(extraPrice(p))}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        )}
        <GuestPicker value={guest} onChange={setGuest} nameLabel={kind === 'walk_in' ? 'Guest name (optional)' : 'Guest name'} required={kind === 'scheduled'} />
        {kind === 'walk_in' && (
          <Checkbox
            label="Already served before I could record it (late entry)"
            checked={form.late}
            onChange={(e) => set('late', e.target.checked)}
          />
        )}
        {late && (
          <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
            <p className="text-sm text-amber-900">
              Enter the real times from the therapist’s note. It is marked as entered late for the owner to check. The therapist must have clocked in by then; if
              they forgot, add their time record first under Time Records.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Therapist who served">
                <Select required value={form.therapistId} onChange={(e) => set('therapistId', e.target.value)}>
                  <option value="">Choose…</option>
                  {therapists.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.displayName}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Room">
                <Select required value={form.roomId} onChange={(e) => set('roomId', e.target.value)}>
                  <option value="">Choose…</option>
                  {(rooms.data?.rooms ?? [])
                    .filter((r) => r.active)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Started at">
                <Input type="time" required value={form.startedAt} onChange={(e) => set('startedAt', e.target.value)} />
              </Field>
              <Field label="Finished at" hint="Leave blank if still in service">
                <Input type="time" value={form.finishedAt} onChange={(e) => set('finishedAt', e.target.value)} />
              </Field>
            </div>
            {lateRoom?.isFlex && (
              <Field label="Room set up as">
                <Select value={form.flexMode} onChange={(e) => set('flexMode', e.target.value as 'floor' | 'recliner')}>
                  <option value="floor">Floor bed</option>
                  <option value="recliner">Foot recliner</option>
                </Select>
              </Field>
            )}
            <Checkbox label="The guest asked for this therapist" checked={form.requested} onChange={(e) => set('requested', e.target.checked)} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          {!late && (
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
          )}
          {kind === 'scheduled' && (
            <Field label="Date and time">
              <Input type="datetime-local" required value={form.scheduledAt} onChange={(e) => set('scheduledAt', e.target.value)} />
            </Field>
          )}
        </div>
        <Field label="Notes" hint="E.g. which add-on part of a combo, pressure, allergies">
          <Input value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
        {kind === 'walk_in' && !late && (
          <Checkbox label="Start now if a therapist and room are free" checked={form.startNow} onChange={(e) => set('startNow', e.target.checked)} />
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={create.isPending || start.isPending}>
            {kind === 'scheduled' ? 'Save booking' : late ? 'Save late entry' : form.startNow ? 'Add and start' : 'Add to waiting list'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
