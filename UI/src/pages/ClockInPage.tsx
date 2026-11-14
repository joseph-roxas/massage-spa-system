import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router';
import { BrandMark } from '../components/Brand';
import { ApiError } from '../lib/api';
import { manilaTime, useClockStaff, usePunch, type ClockStaff, type ClockToday } from '../lib/attendance';
import { useCurrentUser } from '../lib/auth';

/** Today's date and a running clock, Manila time, and whether today is a Holiday. */
function TodayPanel({ today }: { today: ClockToday | undefined }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const opts = { timeZone: 'Asia/Manila' } as const;
  return (
    <div className="text-right">
      <p className="text-4xl font-semibold tabular-nums">{now.toLocaleTimeString('en-PH', { ...opts, hour: 'numeric', minute: '2-digit', second: '2-digit' })}</p>
      <p className="text-lg text-stone-600">{now.toLocaleDateString('en-PH', { ...opts, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>
      {today &&
        (today.holiday ? (
          <p className="mt-1 inline-block rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-900">
            {today.holiday.type === 'regular' ? 'Regular Holiday' : 'Special Day'}: {today.holiday.name}
          </p>
        ) : (
          <p className="mt-1 text-sm text-stone-500">Regular day, not a holiday</p>
        ))}
    </div>
  );
}

const CONFETTI = ['#0f766e', '#f59e0b', '#e11d48', '#6366f1', '#16a34a', '#f97316'];

/** A full-screen celebration on a staff member's first clock-in on their birthday; any tap closes it. */
function BirthdayCard({ name, onClose }: { name: string; onClose: () => void }) {
  return (
    <div role="dialog" aria-label="Happy birthday" className="fixed inset-0 z-20 flex cursor-pointer items-center justify-center overflow-hidden bg-teal-900/80 p-6" onClick={onClose}>
      <style>{`@keyframes spa-confetti { from { transform: translateY(-10vh) rotate(0deg); } to { transform: translateY(110vh) rotate(720deg); } }`}</style>
      {Array.from({ length: 60 }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className="absolute top-0 h-3 w-2 rounded-sm"
          style={{
            left: `${(i * 37) % 100}%`,
            background: CONFETTI[i % CONFETTI.length],
            animation: `spa-confetti ${3 + (i % 5)}s linear ${(i % 10) * 0.3}s infinite`,
          }}
        />
      ))}
      <div className="relative max-w-lg rounded-3xl bg-white px-10 py-12 text-center shadow-2xl">
        <p className="text-7xl">🎂</p>
        <p className="mt-4 text-4xl font-bold text-teal-800">Happy birthday, {name}!</p>
        <p className="mt-3 text-lg text-stone-600">Everyone at the shop wishes you a wonderful day.</p>
        <p className="mt-8 text-sm text-stone-400">Tap anywhere to continue</p>
      </div>
    </div>
  );
}

const ROLE = (s: ClockStaff) =>
  s.kind === 'receptionist'
    ? 'Receptionist'
    : s.kind === 'reliever'
      ? 'Outside Reliever'
      : `${s.therapistClass === 'lmt' ? 'LMT' : 'Therapist'}${s.isOnCall ? ' · On-call' : ''}`;

/** Picked at random after each clock-in and clock-out, for everyone. */
const WELCOMES = [
  (n: string) => `Welcome, ${n}! Let’s make today wonderful!`,
  (n: string) => `Good to see you, ${n}! Have a great shift.`,
  (n: string) => `Hello, ${n}! Your guests are lucky to have you today.`,
  (n: string) => `Welcome back, ${n}! Wishing you a calm and happy shift.`,
  (n: string) => `Hi, ${n}! Let’s give every guest our best today.`,
  (n: string) => `Welcome, ${n}! May today bring you kind guests and good vibes.`,
  (n: string) => `Good day, ${n}! Thank you for being here.`,
  (n: string) => `Welcome, ${n}! Take a deep breath, and let’s have a lovely day.`,
];
const GOODBYES = [
  (n: string) => `Thank you for today, ${n}! Take care and see you next shift!`,
  (n: string) => `Great work today, ${n}! Rest well.`,
  (n: string) => `Thank you, ${n}! Get home safe and have a good rest.`,
  (n: string) => `Well done today, ${n}! Your hard work is appreciated.`,
  (n: string) => `Salamat, ${n}! Take care on the way home.`,
  (n: string) => `Thank you for all your care today, ${n}! See you soon.`,
  (n: string) => `Time to rest, ${n}! Thank you for a good day’s work.`,
  (n: string) => `Goodbye for now, ${n}! You did great today.`,
];
/** The name staff go by, written normally: "ANA MARIA" → "Ana Maria". */
const calledBy = (displayName: string) => displayName.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
const greeting = (action: 'in' | 'out', name: string) => {
  const list = action === 'in' ? WELCOMES : GOODBYES;
  return list[Math.floor(Math.random() * list.length)]!(name);
};

/** What the screen shows after a punch: the time recorded, then a greeting. */
type PunchMessage = { time: string; greeting: string };

/** Long enough to read both lines. */
const MESSAGE_MS = 6000;

function PinPad({ person, onClose, onDone }: { person: ClockStaff; onClose: () => void; onDone: (msg: PunchMessage, birthdayName: string | null) => void }) {
  const [pin, setPin] = useState('');
  const punch = usePunch();
  const action = person.clockedInAt ? 'out' : 'in';
  // A Therapist covering the front desk; an Outside Reliever always is.
  const [relief, setRelief] = useState(false);

  // Submit as soon as the fourth digit is in.
  useEffect(() => {
    if (pin.length !== 4 || punch.isPending) return;
    punch.mutate(
      { staffId: person.id, pin, action, relief },
      {
        onSuccess: (r) =>
          onDone(
            { time: `You clocked ${r.action} at ${manilaTime(r.at)}.`, greeting: greeting(r.action, calledBy(r.displayName)) },
            r.birthday ? r.firstName : null,
          ),
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
        {action === 'in' && person.kind === 'therapist' && !person.isOnCall && (
          <label className="mt-3 flex items-center justify-center gap-2 text-sm">
            <input type="checkbox" checked={relief} onChange={(e) => setRelief(e.target.checked)} /> Relieving the front desk today
          </label>
        )}
        {action === 'in' && person.kind === 'reliever' && <p className="mt-2 text-center text-sm text-teal-800">Relief Shift at the front desk</p>}
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
  const { data: user } = useCurrentUser();
  const [selected, setSelected] = useState<ClockStaff | null>(null);
  const [message, setMessage] = useState<PunchMessage | null>(null);
  const [birthday, setBirthday] = useState<string | null>(null);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), MESSAGE_MS);
    return () => clearTimeout(t);
  }, [message]);

  const people = data?.staff ?? [];
  // Neither logged in nor the Front-desk Device.
  if (error instanceof ApiError && error.status === 401) return <Navigate to="/login" replace />;

  return (
    <main className="min-h-screen bg-stone-100 p-8 text-stone-800">
      <header className="mb-8 flex items-start justify-between gap-6">
        <div>
          <div className="mb-3">
            <BrandMark large />
          </div>
          <p className="text-sm font-semibold uppercase tracking-widest text-teal-700">Clock-in Screen</p>
          <h1 className="text-3xl font-semibold">Tap your name</h1>
          <Link to={user ? '/' : '/login'} className="mt-3 inline-block rounded-md border border-stone-300 bg-white px-4 py-2 text-sm hover:bg-stone-50">
            {user ? 'Back to Front Desk' : 'Back to log in'}
          </Link>
        </div>
        <TodayPanel today={data?.today} />
      </header>

      {message && (
        <div role="status" className="mb-6 rounded-xl bg-teal-700 px-6 py-5 text-center text-white">
          <p className="text-2xl font-semibold">{message.time}</p>
          <p className="mt-1 text-xl">{message.greeting}</p>
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
              {!p.hasPin ? 'No PIN set' : p.clockedInAt ? `${p.relieving ? 'Relieving the front desk' : 'In'} since ${manilaTime(p.clockedInAt)}` : 'Not clocked in'}
            </p>
          </button>
        ))}
      </div>

      {selected && (
        <PinPad
          person={selected}
          onClose={() => setSelected(null)}
          onDone={(msg, birthdayName) => {
            setSelected(null);
            setMessage(msg);
            setBirthday(birthdayName);
          }}
        />
      )}
      {birthday && <BirthdayCard name={birthday} onClose={() => setBirthday(null)} />}
    </main>
  );
}
