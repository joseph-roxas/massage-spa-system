import { useState, type ReactNode } from 'react';
import { peso } from '../../lib/format';

/*
 * Dashboard charts, in the same marks as the Reports charts: thin bars with 4px
 * rounded ends on a recessive baseline, one direct label, a tooltip on hover.
 * Colour names a series; values stay in text ink. Sales and Expenses are always
 * the same two colours, and the legend carries identity.
 */

const SALES = '#0d9488';
const EXPENSES = '#d97706';
const BAR = '#0d9488';

const shortDay = (d: string) => new Date(`${d}T00:00:00+08:00`).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' });
export const monthName = (m: string, style: 'short' | 'long' = 'short') => new Date(`${m}-15T00:00:00+08:00`).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: style, ...(style === 'long' ? { year: 'numeric' } : {}) });

function Tooltip({ left, children }: { left: string; children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-xs text-stone-800 shadow-md" style={{ left, top: 24 }}>
      {children}
    </div>
  );
}

const barPath = (x: number, w: number, h: number, base: number) => {
  const r = Math.min(4, h, w / 2);
  return `M${x},${base} V${base - h + r} q0,-${r} ${r},-${r} H${x + w - r} q${r},0 ${r},${r} V${base} Z`;
};

/** Sales beside Expenses for each day. */
export function SalesExpensesChart({ days }: { days: { date: string; sales: number; expenses: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.flatMap((d) => [d.sales, d.expenses]));
  const H = 180;
  const W = 720;
  const slot = W / Math.max(days.length, 1);
  const bw = Math.max(2, Math.min(12, (slot - 4) / 2));
  const every = Math.ceil(days.length / 8);
  const scale = (v: number) => (v ? Math.max(2, (v / max) * (H - 12)) : 0);
  const shown = hover === null ? null : days[hover]!;
  return (
    <figure className="relative">
      <div className="mb-2 flex gap-4 text-xs text-stone-600">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: SALES }} />Sales</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: EXPENSES }} />Expenses</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H + 22}`} className="w-full" role="img" aria-label="Sales and expenses per day, bar chart">
        <line x1={0} x2={W} y1={H} y2={H} stroke="#d6d3d1" strokeWidth={1} />
        {days.map((d, i) => {
          const x = i * slot + (slot - bw * 2 - 2) / 2;
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={i * slot} y={0} width={slot} height={H} fill={hover === i ? '#f5f5f4' : 'transparent'} />
              {d.sales > 0 && <path d={barPath(x, bw, scale(d.sales), H)} fill={SALES} />}
              {d.expenses > 0 && <path d={barPath(x + bw + 2, bw, scale(d.expenses), H)} fill={EXPENSES} />}
              {i % every === 0 && (
                <text x={i * slot + slot / 2} y={H + 15} textAnchor="middle" className="fill-stone-500 text-[11px]">
                  {shortDay(d.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {shown && hover !== null && (
        <Tooltip left={`${Math.min(85, Math.max(15, ((hover + 0.5) / days.length) * 100))}%`}>
          <span className="font-medium">{shortDay(shown.date)}</span> · Sales {peso(shown.sales)} · Expenses {peso(shown.expenses)}
        </Tooltip>
      )}
    </figure>
  );
}

/** Columns with a label below and a value above the largest; `format` gives the value's text. */
export function Columns({ rows, label, format }: { rows: { key: string; label: string; value: number }[]; label: string; format: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...rows.map((r) => r.value));
  const top = rows.findIndex((r) => r.value === max);
  const H = 110;
  const W = 360;
  const slot = W / rows.length;
  const bw = Math.min(32, slot - 6);
  return (
    <figure className="relative">
      <svg viewBox={`0 0 ${W} ${H + 22}`} className="w-full" role="img" aria-label={label}>
        <line x1={0} x2={W} y1={H} y2={H} stroke="#d6d3d1" strokeWidth={1} />
        {rows.map((r, i) => {
          const h = r.value ? Math.max(2, (r.value / max) * (H - 20)) : 0;
          const x = i * slot + (slot - bw) / 2;
          return (
            <g key={r.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
              {h > 0 && <path d={barPath(x, bw, h, H)} fill={BAR} opacity={hover === i ? 0.8 : 1} />}
              {i === top && r.value > 0 && (
                <text x={x + bw / 2} y={H - h - 5} textAnchor="middle" className="fill-stone-600 text-[11px]">
                  {format(r.value)}
                </text>
              )}
              <text x={x + bw / 2} y={H + 15} textAnchor="middle" className="fill-stone-500 text-[11px]">
                {r.label}
              </text>
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <Tooltip left={`${Math.min(85, Math.max(15, ((hover + 0.5) / rows.length) * 100))}%`}>
          <span className="font-medium">{rows[hover]!.label}</span> · {format(rows[hover]!.value)}
        </Tooltip>
      )}
    </figure>
  );
}

/** Horizontal bars, largest first. */
export function Ranking({ rows, empty }: { rows: { name: string; amount: number }[]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-stone-500">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.amount), 1);
  return (
    <ul className="space-y-1">
      {rows.map((r) => (
        <li key={r.name} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-3 text-sm" title={`${r.name}: ${peso(r.amount)}`}>
          <span className="truncate text-stone-700">{r.name}</span>
          <span className="h-3">
            <span className="block h-full rounded-r-[4px]" style={{ width: `${Math.max(1, (r.amount / max) * 100)}%`, background: BAR }} />
          </span>
          <span className="text-right tabular-nums text-stone-600">{peso(r.amount)}</span>
        </li>
      ))}
    </ul>
  );
}
