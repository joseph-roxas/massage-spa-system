import { useState } from 'react';
import { Badge, Checkbox, Field, Input } from './ui';
import { useGuests, visitsLabel, type GuestListed } from '../lib/guests';

/** Who a Booking or Voucher sale is for: a picked Guest Record, a new one saved from the typed name, or just a name. */
export type GuestChoice = { guestId: string | null; guestName: string; guestPhone: string; saveGuest: boolean };

export const NO_GUEST: GuestChoice = { guestId: null, guestName: '', guestPhone: '', saveGuest: true };

/** The fields a booking or sale request sends for the chosen Guest. */
export const guestBody = (g: GuestChoice) => ({ guestId: g.guestId, guestName: g.guestName, guestPhone: g.guestPhone, saveGuest: !g.guestId && g.saveGuest && !!g.guestName.trim() });

/**
 * Typing a name or phone lists matching Guest Records to pick; otherwise the
 * typed name is saved as a new record unless the box is unticked.
 */
export function GuestPicker({
  value,
  onChange,
  nameLabel = 'Guest name',
  required,
}: {
  value: GuestChoice;
  onChange: (g: GuestChoice) => void;
  nameLabel?: string;
  required?: boolean;
}) {
  const [picked, setPicked] = useState<GuestListed | null>(null);
  const [focused, setFocused] = useState(false);
  const term = value.guestName.trim().length >= 2 ? value.guestName.trim() : value.guestPhone.trim().length >= 3 ? value.guestPhone.trim() : '';
  const matches = useGuests(term, !value.guestId && term !== '');
  const found = (matches.data?.guests ?? []).slice(0, 6);

  if (value.guestId && picked) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-teal-200 bg-teal-50/60 px-3 py-2 text-sm">
        <div>
          <p className="font-medium">
            {picked.name} {picked.isRegular && <Badge tone="teal">Regular</Badge>}
          </p>
          <p className="text-xs text-stone-600">
            {[picked.phone, visitsLabel(picked), picked.statutoryIdMasked && `ID ${picked.statutoryIdMasked}`].filter(Boolean).join(' · ')}
          </p>
        </div>
        <button
          type="button"
          className="text-xs text-stone-500 underline"
          onClick={() => {
            setPicked(null);
            onChange({ ...value, guestId: null });
          }}
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="relative grid grid-cols-2 gap-3">
        <Field label={nameLabel}>
          <Input
            required={required}
            value={value.guestName}
            autoComplete="off"
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
            onChange={(e) => onChange({ ...value, guestName: e.target.value })}
          />
        </Field>
        <Field label="Phone (optional)">
          <Input
            inputMode="tel"
            value={value.guestPhone}
            autoComplete="off"
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
            onChange={(e) => onChange({ ...value, guestPhone: e.target.value })}
          />
        </Field>
        {focused && found.length > 0 && (
          <ul className="absolute left-0 right-0 top-full z-10 mt-1 divide-y divide-stone-100 overflow-hidden rounded-md border border-stone-200 bg-white text-sm shadow-lg">
            {found.map((g) => (
              <li key={g.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-teal-50"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setPicked(g);
                    onChange({ guestId: g.id, guestName: g.name, guestPhone: g.phone ?? '', saveGuest: false });
                  }}
                >
                  <span>
                    <span className="font-medium">{g.name}</span>
                    {g.phone && <span className="text-stone-500"> · {g.phone}</span>}
                  </span>
                  <span className="text-xs text-stone-500">
                    {g.isRegular && <Badge tone="teal">Regular</Badge>} {visitsLabel(g)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {value.guestName.trim() && (
        <Checkbox label="Save as a new Guest Record" checked={value.saveGuest} onChange={(e) => onChange({ ...value, saveGuest: e.target.checked })} />
      )}
    </div>
  );
}
