import { Button } from '../components/ui';
import { useClockStaff } from '../lib/attendance';
import { useServices } from '../lib/catalogue';
import { duration, peso } from '../lib/format';

const GUEST_ROWS = 22;
const CASH_OUT_ROWS = 6;

const cellCls = 'border border-stone-400 px-1.5 py-1 align-top';
const headCls = `${cellCls} bg-stone-100 text-left text-[10px] font-semibold uppercase tracking-wide`;

/** A printable sheet for running the front desk on paper while the internet is down. */
export function PaperSheetPage() {
  const staff = useClockStaff();
  const services = useServices();
  const people = staff.data?.staff ?? [];
  const priced = (services.data?.services ?? []).filter((s) => s.active && s.currentPrice !== null);

  return (
    <div className="space-y-4">
      {/* Only while this page is open: the log is wide, so print it sideways. */}
      <style>{'@page { size: A4 landscape; margin: 8mm; }'}</style>
      <div className="flex items-center justify-between print:hidden">
        <div>
          <h1 className="text-2xl font-semibold">Paper backup sheet</h1>
          <p className="text-sm text-stone-600">Print a few copies for days the internet is down. Enter every line in the system once it is back, before Day Close.</p>
        </div>
        <Button onClick={() => window.print()}>Print</Button>
      </div>

      <section className="space-y-3 bg-white p-4 text-[11px] text-stone-900 print:p-0">
        <header className="flex items-end justify-between border-b-2 border-stone-800 pb-1">
          <h2 className="text-base font-bold">Front desk paper log</h2>
          <span>Business Day: ____________________ Receptionist: ____________________</span>
        </header>

        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={`${headCls} w-6`}>#</th>
              <th className={`${headCls} w-14`}>Start</th>
              <th className={`${headCls} w-14`}>Done</th>
              <th className={headCls}>Guest (optional)</th>
              <th className={`${headCls} w-14`}>Service code</th>
              <th className={headCls}>Therapist</th>
              <th className={`${headCls} w-10`}>Asked for?</th>
              <th className={`${headCls} w-10`}>Room</th>
              <th className={headCls}>Discount: SC/PWD ID, promo, voucher serial</th>
              <th className={`${headCls} w-12`}>Oil</th>
              <th className={`${headCls} w-16`}>Paid ₱</th>
              <th className={headCls}>Cash / GCash ref</th>
              <th className={`${headCls} w-8`}>In sys.</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: GUEST_ROWS }, (_, i) => (
              <tr key={i} className="h-6">
                <td className={`${cellCls} text-center text-stone-500`}>{i + 1}</td>
                {Array.from({ length: 12 }, (_, j) => (
                  <td key={j} className={cellCls} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        <div className="grid grid-cols-2 gap-4">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={headCls}>Staff (arrival order = rotation)</th>
                <th className={`${headCls} w-16`}>In</th>
                <th className={`${headCls} w-16`}>Out</th>
              </tr>
            </thead>
            <tbody>
              {(people.length ? people.map((p) => p.displayName) : Array.from({ length: 8 }, () => '')).map((name, i) => (
                <tr key={i} className="h-6">
                  <td className={cellCls}>{name}</td>
                  <td className={cellCls} />
                  <td className={cellCls} />
                </tr>
              ))}
            </tbody>
          </table>

          <div className="space-y-3">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className={headCls}>Cash-out: what for</th>
                  <th className={`${headCls} w-20`}>₱</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: CASH_OUT_ROWS }, (_, i) => (
                  <tr key={i} className="h-6">
                    <td className={cellCls} />
                    <td className={cellCls} />
                  </tr>
                ))}
              </tbody>
            </table>
            <p>Cash counted at close: ₱ ______________ GCash total: ₱ ______________</p>
          </div>
        </div>

        {priced.length > 0 && (
          <div>
            <p className="mb-1 font-semibold">Service codes and prices</p>
            <div className="grid grid-cols-3 gap-x-4">
              {priced.map((s) => (
                <span key={s.id} className="flex justify-between gap-2 border-b border-dotted border-stone-300">
                  <span>
                    <span className="font-mono font-semibold">{s.code}</span> {s.name} ({duration(s.durationMin)})
                  </span>
                  <span className="tabular-nums">{peso(s.currentPrice)}</span>
                </span>
              ))}
            </div>
          </div>
        )}
        <p className="text-stone-600">Senior/PWD: 20% off with ID number. Only one discount per guest: the larger one. Extra oil ₱50 is never discounted.</p>
      </section>
    </div>
  );
}
