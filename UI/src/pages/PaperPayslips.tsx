import type { ReactNode } from 'react';
import { effectiveOn } from '@spa/domain';
import { useCan } from '../lib/auth';
import { useCommissionRates, usePayRules } from '../lib/catalogue';
import { percent, todayManila } from '../lib/format';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const cellCls = 'border border-stone-400 px-1.5 py-1 align-top';
const headCls = `${cellCls} bg-stone-100 text-left text-[9px] font-semibold uppercase tracking-wide`;
const blank = '______________';

/** One half of an A4 page; two print per sheet with a dashed line to cut along. */
function Half({ title, weekDays = ['Sun', 'Sat'], children }: { title: string; weekDays?: [string, string]; children: ReactNode }) {
  return (
    <section className="flex h-[138mm] flex-col gap-2 overflow-hidden border-b border-dashed border-stone-400 bg-white p-4 text-[10px] text-stone-900 last:border-b-0 print:p-0 print:pb-3">
      <header className="flex items-end justify-between border-b-2 border-stone-800 pb-1">
        <h2 className="text-sm font-bold">{title}</h2>
        <span>
          Pay Week: {weekDays[0]} {blank} to {weekDays[1]} {blank}
        </span>
      </header>
      {children}
    </section>
  );
}

/** A label and a blank to write an amount on. */
function Blank({ label, strong, minus }: { label: string; strong?: boolean; minus?: boolean }) {
  return (
    <div className={`flex items-end justify-between gap-2 ${strong ? 'border-t border-stone-800 pt-1 font-bold' : ''}`}>
      <span>{label}</span>
      <span className="w-24 border-b border-stone-500 text-right text-stone-400">{minus ? '− ₱' : '₱'}</span>
    </div>
  );
}

function Signatures() {
  return (
    <div className="mt-auto grid grid-cols-3 gap-6 pt-3">
      <p className="border-t border-stone-500 pt-0.5">Prepared by</p>
      <p className="border-t border-stone-500 pt-0.5">Received by (signature)</p>
      <p className="border-t border-stone-500 pt-0.5">Date</p>
    </div>
  );
}

/** Today's Commission rates, from the owner's Settings. */
function RateText() {
  const rates = useCommissionRates().data?.commissionRates ?? [];
  const text = (['regular', 'lmt'] as const)
    .map((cls) => {
      const r = effectiveOn(
        rates.filter((x) => x.therapistClass === cls),
        todayManila(),
      );
      return r ? `${cls === 'lmt' ? 'LMT' : 'Regular'} ${percent(r.normalBp)} (Holiday ${percent(r.holidayBp)})` : null;
    })
    .filter(Boolean)
    .join(' · ');
  return <>{text || RATE_BLANK}</>;
}

const RATE_BLANK = '______ % (Holiday ______ %)';

/** A Therapist's week: each day's sales and Commission, CAs taken, deductions and net. */
function TherapistSlip() {
  // Only the owner can read the rates; the Receptionist's copy leaves them to fill in.
  const isOwner = useCan('settings.manage');
  return (
    <Half title="Therapist payslip" weekDays={['Mon', 'Sun']}>
      <p>
        Name: {blank}
        {blank} Regular / LMT (circle) · Commission rate: {isOwner ? <RateText /> : RATE_BLANK}
      </p>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={`${headCls} w-16`}>Day / date</th>
            <th className={`${headCls} w-12`}>Guests</th>
            <th className={headCls}>Sales (Regular Price) ₱</th>
            <th className={`${headCls} w-12`}>Holiday?</th>
            <th className={headCls}>Commission ₱</th>
            <th className={headCls}>Relief pay ₱</th>
          </tr>
        </thead>
        <tbody>
          {DAYS.map((d) => (
            <tr key={d} className="h-[18px]">
              <td className={cellCls}>{d}</td>
              {Array.from({ length: 5 }, (_, j) => (
                <td key={j} className={cellCls} />
              ))}
            </tr>
          ))}
          <tr className="h-[18px] font-bold">
            <td className={cellCls}>Total</td>
            {Array.from({ length: 5 }, (_, j) => (
              <td key={j} className={cellCls} />
            ))}
          </tr>
        </tbody>
      </table>
      <div className="grid grid-cols-2 gap-4">
        <table className="w-full border-collapse self-start">
          <thead>
            <tr>
              <th className={headCls}>Cash Advance taken: date</th>
              <th className={`${headCls} w-20`}>₱</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 4 }, (_, i) => (
              <tr key={i} className="h-[18px]">
                <td className={cellCls} />
                <td className={cellCls} />
              </tr>
            ))}
          </tbody>
        </table>
        <div className="space-y-1">
          <Blank label="Commission" />
          <Blank label="Relief pay" />
          <Blank label="Adjustment: ____________" />
          <Blank label="Total earned" strong />
          <Blank label="SSS" minus />
          <Blank label="PhilHealth" minus />
          <Blank label="Pag-IBIG" minus />
          <Blank label="Cash Advances" minus />
          <Blank label="Net pay" strong />
        </div>
      </div>
      <Signatures />
    </Half>
  );
}

/** The Receptionist's week: each day's times, the payslip lines, and the CA balance. */
function ReceptionistSlip() {
  const rules = usePayRules().data?.payRules;
  const premiums = rules?.receptionist_premiums as Record<string, { workedPct: number; otPct: number }> | undefined;
  const hint = premiums
    ? `Rest Day ${premiums.restDay?.workedPct}% · Special Day ${premiums.special?.workedPct}% · Regular Holiday ${premiums.regular?.workedPct}% · Overtime ${premiums.ordinary?.otPct}%`
    : '';
  return (
    <Half title="Receptionist payslip">
      <p>
        Name: {blank}
        {blank} Daily rate: ₱ {blank} Per minute: daily rate ÷ 480
      </p>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={`${headCls} w-16`}>Day / date</th>
            <th className={`${headCls} w-16`}>Day type</th>
            <th className={headCls}>In</th>
            <th className={headCls}>Out</th>
            <th className={`${headCls} w-12`}>Late min</th>
            <th className={`${headCls} w-14`}>Undertime min</th>
            <th className={`${headCls} w-12`}>OT min</th>
            <th className={headCls}>Day pay ₱</th>
          </tr>
        </thead>
        <tbody>
          {DAYS.map((d) => (
            <tr key={d} className="h-[18px]">
              <td className={cellCls}>{d}</td>
              {Array.from({ length: 7 }, (_, j) => (
                <td key={j} className={cellCls} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-stone-600">Day type: Ordinary · Rest Day · Special Day · Regular Holiday (worked or not). {hint}</p>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Blank label="Basic pay (___ days × daily rate)" />
          <Blank label="Rest Day premium" />
          <Blank label="Holiday premium (worked)" />
          <Blank label="Holiday pay (not worked)" />
          <Blank label="Overtime" />
          <Blank label="Adjustment: ____________" />
          <Blank label="Total earned" strong />
        </div>
        <div className="space-y-1">
          <Blank label="Late" minus />
          <Blank label="Undertime" minus />
          <Blank label="SSS" minus />
          <Blank label="PhilHealth" minus />
          <Blank label="Pag-IBIG" minus />
          <Blank label="CA Repayment" minus />
          <Blank label="Net pay" strong />
        </div>
      </div>
      <p>
        Cash Advance balance before: ₱ {blank} Repaid this week: ₱ {blank} Balance after: ₱ {blank}
      </p>
      <Signatures />
    </Half>
  );
}

export type PaperPayslipKind = 'therapist' | 'receptionist';

/** Blank Paper Payslips, two per A4 sheet, for writing a week's pay by hand when the system can't be used. */
export function PaperPayslips({ kind }: { kind: PaperPayslipKind }) {
  const Slip = kind === 'therapist' ? TherapistSlip : ReceptionistSlip;
  return (
    <div>
      <style>{'@page { size: A4 portrait; margin: 8mm; }'}</style>
      <Slip />
      <Slip />
    </div>
  );
}

/** Which Paper Payslips this user may print: Therapist ones with Therapist payroll, the Receptionist's for the owner. */
export function usePaperPayslipKinds(): PaperPayslipKind[] {
  const therapist = useCan('payroll.therapist.generate');
  const receptionist = useCan('payroll.receptionist.manage');
  return [...(therapist ? (['therapist'] as const) : []), ...(receptionist ? (['receptionist'] as const) : [])];
}
