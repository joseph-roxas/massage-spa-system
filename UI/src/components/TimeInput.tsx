import { useState } from 'react';

/*
 * Times are always entered in 12-hour form, the same on every device: a
 * browser's own time box follows the computer's clock setting and can show
 * 24-hour time. Values in and out stay "HH:MM" (24-hour), as the API expects.
 */

type Period = 'AM' | 'PM';
type Parts = { h: string; m: string; p: Period };

const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));
const PART = 'h-10 min-w-0 flex-1 rounded-md border border-stone-300 bg-white px-2 text-sm text-stone-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20';

function partsOf(value: string): Parts | null {
  if (!/^\d{2}:\d{2}$/.test(value)) return null;
  const h = Number(value.slice(0, 2));
  return { h: String(h % 12 || 12), m: value.slice(3, 5), p: h >= 12 ? 'PM' : 'AM' };
}

function valueOf(p: Parts): string {
  if (!p.h || !p.m) return '';
  const h = (Number(p.h) % 12) + (p.p === 'PM' ? 12 : 0);
  return `${String(h).padStart(2, '0')}:${p.m}`;
}

export function TimeInput({
  value,
  onChange,
  required,
  autoFocus,
  className = '',
  label = 'Time',
  defaultPeriod = 'PM',
}: {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  autoFocus?: boolean;
  className?: string;
  label?: string;
  /** Before anything is picked; the shop's hours are mostly afternoon and evening. */
  defaultPeriod?: Period;
}) {
  const [draft, setDraft] = useState<Parts>(() => partsOf(value) ?? { h: '', m: '', p: defaultPeriod });
  // Follow changes from outside, e.g. a form cleared after saving.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    const parts = partsOf(value);
    if (parts) setDraft(parts);
    else if (!value && valueOf(draft)) setDraft({ h: '', m: '', p: draft.p });
  }

  const set = (patch: Partial<Parts>) => {
    const next = { ...draft, ...patch };
    if (patch.h && !next.m) next.m = '00';
    setDraft(next);
    onChange(valueOf(next));
  };

  return (
    <span role="group" aria-label={label} className={`flex w-full gap-1 ${className}`}>
      <select aria-label="Hour" className={PART} required={required} autoFocus={autoFocus} value={draft.h} onChange={(e) => set({ h: e.target.value })}>
        <option value="">--</option>
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
      <select aria-label="Minute" className={PART} required={required} value={draft.m} onChange={(e) => set({ m: e.target.value })}>
        <option value="">--</option>
        {MINUTES.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <select aria-label="AM or PM" className={PART} value={draft.p} onChange={(e) => set({ p: e.target.value as Period })}>
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </span>
  );
}

/** A date and a 12-hour time; the value is "YYYY-MM-DDTHH:MM", like a datetime-local box. */
export function DateTimeInput({ value, onChange, required, min, max }: { value: string; onChange: (value: string) => void; required?: boolean; min?: string; max?: string }) {
  const [date, setDate] = useState(value.slice(0, 10));
  const [time, setTime] = useState(value.slice(11, 16));
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (value) {
      setDate(value.slice(0, 10));
      setTime(value.slice(11, 16));
    }
  }
  const emit = (d: string, t: string) => onChange(d && t ? `${d}T${t}` : '');
  return (
    <span className="flex w-full flex-wrap gap-1">
      <input
        type="date"
        aria-label="Date"
        className="h-10 min-w-36 flex-1 rounded-md border border-stone-300 bg-white px-3 text-sm text-stone-900 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20"
        required={required}
        min={min?.slice(0, 10)}
        max={max?.slice(0, 10) ?? '9999-12-31'}
        value={date}
        onChange={(e) => {
          setDate(e.target.value);
          emit(e.target.value, time);
        }}
      />
      <TimeInput
        className="min-w-44 flex-1"
        required={required}
        value={time}
        onChange={(t) => {
          setTime(t);
          emit(date, t);
        }}
      />
    </span>
  );
}
