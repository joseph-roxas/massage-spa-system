import { useState, type ReactNode } from 'react';
import type { Report } from '@spa/domain';
import { peso } from '../../lib/format';

/*
 * Single-series charts: one hue (the app's teal) for magnitude, thin marks with
 * 4px rounded data-ends on the baseline, a 2px gap between bars, a recessive
 * baseline, one direct label (the largest), and a tooltip on hover. The table
 * below each chart is the exact-number view.
 */

const BAR = 'var(--chart-bar, #0f766e)';
const BAR_HOVER = 'var(--chart-bar-hover, #115e59)';

const shortDay = (d: string) => new Date(`${d}T00:00:00+08:00`).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' });

function Tooltip({ left, children }: { left: string; children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-xs text-stone-800 shadow-md" style={{ left, top: -6 }}>
      {children}
    </div>
  );
}

/** Columns over days: one bar per Business Day of `valueKey`. */
export function DailyBars({ report, valueKey, label }: { report: Report; valueKey: string; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const rows = report.rows.filter((r) => r.date);
  if (rows.length < 2) return null;
  const values = rows.map((r) => Number(r[valueKey]) || 0);
  const max = Math.max(...values, 1);
  const top = values.indexOf(max);
  const H = 160;
  const W = 720;
  const slot = W / rows.length;
  const bw = Math.max(2, Math.min(28, slot - 2));
  const every = Math.ceil(rows.length / 10);

  return (
    <figure className="relative mb-4">
      <figcaption className="mb-2 text-sm font-medium text-stone-700">{label} per day</figcaption>
      <svg viewBox={`0 0 ${W} ${H + 22}`} className="w-full" role="img" aria-label={`${label} per day, bar chart`}>
        <line x1={0} x2={W} y1={H} y2={H} stroke="#d6d3d1" strokeWidth={1} />
        {rows.map((r, i) => {
          const h = Math.max(values[i]! ? 2 : 0, (values[i]! / max) * (H - 18));
          const x = i * slot + (slot - bw) / 2;
          return (
            <g key={String(r.date)} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {/* Hit target taller and wider than the bar. */}
              <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
              <path
                d={`M${x},${H} V${H - h + Math.min(4, h)} q0,-${Math.min(4, h)} ${Math.min(4, bw / 2)},-${Math.min(4, h)} H${x + bw - Math.min(4, bw / 2)} q${Math.min(4, bw / 2)},0 ${Math.min(4, bw / 2)},${Math.min(4, h)} V${H} Z`}
                fill={hover === i ? BAR_HOVER : BAR}
              />
              {i === top && (
                <text x={x + bw / 2} y={H - h - 5} textAnchor="middle" className="fill-stone-600 text-[11px]">
                  {peso(values[i]!)}
                </text>
              )}
              {i % every === 0 && (
                <text x={x + bw / 2} y={H + 15} textAnchor="middle" className="fill-stone-500 text-[11px]">
                  {shortDay(String(r.date))}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <Tooltip left={`${((hover + 0.5) / rows.length) * 100}%`}>
          <span className="font-medium">{shortDay(String(rows[hover]!.date))}</span> · {peso(values[hover]!)}
        </Tooltip>
      )}
    </figure>
  );
}

/** Horizontal bars, largest first: one per row of `labelKey`. */
export function RankedBars({ report, labelKey, valueKey, label }: { report: Report; labelKey: string; valueKey: string; label: string }) {
  const rows = report.rows.filter((r) => Number(r[valueKey]) > 0);
  if (rows.length < 2) return null;
  const max = Math.max(...rows.map((r) => Number(r[valueKey])));
  return (
    <figure className="mb-4">
      <figcaption className="mb-2 text-sm font-medium text-stone-700">{label}</figcaption>
      <ul className="space-y-0.5">
        {rows.map((r, i) => {
          const v = Number(r[valueKey]);
          return (
            <li key={String(r[labelKey])} className="group grid grid-cols-[8rem_1fr_6rem] items-center gap-3 text-sm" title={`${r[labelKey]}: ${peso(v)}`}>
              <span className="truncate text-stone-700">{r[labelKey]}</span>
              <span className="h-3.5">
                <span className="block h-full rounded-r-[4px] bg-teal-700 group-hover:bg-teal-800" style={{ width: `${Math.max(1, (v / max) * 100)}%` }} />
              </span>
              <span className={`text-right tabular-nums ${i === 0 ? 'text-stone-800' : 'text-stone-500'}`}>{peso(v)}</span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

/** Service × hour grid shaded light → dark teal by count. */
export function Heatmap({ report }: { report: Report }) {
  const hourCols = report.columns.filter((c) => /^h\d+$/.test(c.key));
  if (!report.rows.length || !hourCols.length) return null;
  const max = Math.max(1, ...report.rows.flatMap((r) => hourCols.map((c) => Number(r[c.key]) || 0)));
  // Five sequential steps of one hue; 0 is the bare surface.
  const STEPS = ['#ccfbf1', '#99f6e4', '#2dd4bf', '#0d9488', '#115e59'];
  const shade = (v: number) => (v ? STEPS[Math.min(STEPS.length - 1, Math.floor(((v - 1) / max) * STEPS.length))] : 'transparent');

  return (
    <figure className="mb-4 overflow-x-auto">
      <figcaption className="mb-2 text-sm font-medium text-stone-700">Services started per hour</figcaption>
      <table className="border-separate text-xs" style={{ borderSpacing: 2 }}>
        <thead>
          <tr>
            <th />
            {hourCols.map((c) => (
              <th key={c.key} className="px-1 font-normal text-stone-500">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((r) => (
            <tr key={String(r.service)}>
              <th className="max-w-56 truncate pr-2 text-left font-normal text-stone-700">{r.service}</th>
              {hourCols.map((c) => {
                const v = Number(r[c.key]) || 0;
                return (
                  <td
                    key={c.key}
                    title={`${r.service}, ${c.label}: ${v}`}
                    className="h-7 w-10 rounded-[4px] border border-stone-100 text-center tabular-nums"
                    style={{ background: shade(v), color: v && Math.floor(((v - 1) / max) * STEPS.length) >= 3 ? 'white' : '#44403c' }}
                  >
                    {v || ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex items-center gap-1 text-xs text-stone-500">
        Fewer
        {STEPS.map((s) => (
          <span key={s} className="h-3 w-5 rounded-sm" style={{ background: s }} />
        ))}
        More
      </div>
    </figure>
  );
}
