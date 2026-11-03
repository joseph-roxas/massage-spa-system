import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { manilaTime, useClockStaff, usePunch, type ClockStaff } from '../lib/attendance';

const ROLE = (s: ClockStaff) =>
  s.kind === 'receptionist' ? 'Receptionist' : `${s.therapistClass === 'lmt' ? 'LMT' : 'Therapist'}${s.isOnCall ? ' · On-call' : ''}`;

function PinPad({ person, onClose, onDone }: { person: ClockStaff; onClose: () => void; onDone: (msg: string) => void }) {
  const [pin, setPin] = useState('');
  const punch = usePunch();
  const action = person.clockedInAt ? 'out' : 'in';

  // Submit as soon as the fourth digit is in.
  useEffect(() => {
    if (pin.length !== 4 || punch.isPending) return;
    punch.mutate(
      { staffId: person.id, pin, action },
      {
        onSuccess: (r) => onDone(`${r.displayName} clocked ${r.action} at ${manilaTime(r.at)}`),
        onError: () => setPin(''),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per completed PIN
  }, [pin]);

  // The physical keyboard works too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) setPin((p) => (p.length < 4 ? p + e.key : p));
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const press = (d: string) => setPin((p) => (p.length < 4 ? p + d : p));

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-stone-900/60 p-4" onClick={onClose}>
      <div className="w-full max-w-xs rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <p className="text-center text-sm text-stone-500">{action === 'in' ? 'Clock in' : 'Clock out'}</p>
        <p className="text-center text-2xl font-semibold">{person.displayName}</p>
        <div className="my-5 flex justify-center gap-3" aria-label={`${pin.length} of 4 digits entered`}>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={`h-4 w-4 rounded-full ${i < pin.length ? 'bg-teal-700' : 'bg-stone-200'}`} />
          ))}
        </div>
        {punch.error && <p role="alert" className="mb-3 text-center text-sm text-red-700">{punch.error.message}</p>}
        <div className="grid grid-cols-3 gap-2">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button key={d} type="button" onClick={() => press(d)} className="h-14 rounded-xl bg-stone-100 text-xl font-medium hover:bg-stone-200">
              {d}
            </button>
          ))}
          <button type="button" onClick={onClose} className="h-14 rounded-xl text-sm text-stone-500 hover:bg-stone-100">
            Cancel
          </button>
          <button type="button" onClick={() => press('0')} className="h-14 rounded-xl bg-stone-100 text-xl font-medium hover:bg-stone-200">
            0
          </button>
          <button type="button" onClick={() => setPin((p) => p.slice(0, -1))} className="h-14 rounded-xl text-sm text-stone-500 hover:bg-stone-100">
            ⌫
          </button>
        </div>
      </div>
    </div>
  );
}

export function ClockInPage() {
  const { data, error } = useClockStaff();
  const [selected, setSelected] = useState<ClockStaff | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(t);
  }, [message]);

  const people = data?.staff ?? [];

  return (
    <main className="min-h-screen bg-stone-100 p-8 text-stone-800">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-widest text-teal-700">Clock-in Screen</p>
          <h1 className="text-3xl font-semibold">Tap your name</h1>
        </div>
        <Link to="/" className="rounded-md border border-stone-300 bg-white px-4 py-2 text-sm hover:bg-stone-50">
          Back to Front Desk
        </Link>
      </header>

      {message && (
        <div role="status" className="mb-6 rounded-xl bg-teal-700 px-6 py-4 text-center text-lg font-medium text-white">
          {message}
        </div>
      )}
      {error && <p role="alert" className="text-red-700">{error.message}</p>}
      {data && people.length === 0 && <p className="text-stone-500">No staff yet. Add them under Settings → Staff.</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
        {people.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={!p.hasPin}
            onClick={() => setSelected(p)}
            className={`rounded-2xl border-2 p-5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              p.clockedInAt ? 'border-teal-600 bg-teal-50 hover:bg-teal-100' : 'border-stone-200 bg-white hover:border-stone-300'
            }`}
          >
            <p className="text-xl font-semibold">{p.displayName}</p>
            <p className="text-sm text-stone-500">{ROLE(p)}</p>
            <p className={`mt-3 text-sm font-medium ${p.clockedInAt ? 'text-teal-800' : 'text-stone-400'}`}>
              {!p.hasPin ? 'No PIN set' : p.clockedInAt ? `In since ${manilaTime(p.clockedInAt)}` : 'Not clocked in'}
            </p>
          </button>
        ))}
      </div>

      {selected && (
        <PinPad
          person={selected}
          onClose={() => setSelected(null)}
          onDone={(msg) => {
            setSelected(null);
            setMessage(msg);
          }}
        />
      )}
    </main>
  );
}
