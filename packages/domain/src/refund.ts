import type { IsoDate } from './calendar';

/**
 * The Government Deduction Refund's to-do list (ADR 0010). Steps marked
 * `manual` are ticked by the Super Admin; the rest follow from the Payrolls.
 */
export const REFUND_STEPS = [
  {
    key: 'november-final',
    manual: false,
    title: 'Approve the last November Payrolls',
    detail: 'The Therapists’ week of Nov 23–29 and the Receptionist’s week of Nov 22–28, so every deduction up to November is final.',
  },
  {
    key: 'opening-weeks',
    manual: true,
    title: 'Remove opening weeks the shop did not remit',
    detail: 'In the Deferred Deductions table above, click off every week of a month that was not remitted, then press Update for that person.',
  },
  {
    key: 'receptionist-early-months',
    manual: true,
    title: 'Check the Receptionist’s January and February remittances',
    detail: 'Her figure assumes they were remitted at today’s amounts. If they were lower, January and February are worked out from what was remitted.',
  },
  {
    key: 'recompute',
    manual: true,
    title: 'Recompute each person’s refund by agency',
    detail:
      'Upload the updated 2026 Monthly Sales and Receptionist Time Record workbooks and have the refund worked out for January to November: each month’s true share against what was deducted or deferred, leaving out months not remitted. Check the figures before entering them.',
  },
  {
    key: 'entered',
    manual: true,
    title: 'Enter every refund below',
    detail: 'On the payout Pay Week. Someone who was not over-deducted gets no refund, so tick this once everyone who has one is entered.',
  },
  {
    key: 'approved',
    manual: false,
    title: 'Generate and approve the payout week’s Payrolls',
    detail: 'Each Payslip shows the refund by agency, what came off Deferred Deductions and the cash.',
  },
  {
    key: 'released',
    manual: false,
    title: 'Release the Payrolls carrying the refund',
    detail: 'Hand out the Payslips. The reminder goes away once every one is released.',
  },
] as const;

export type RefundStepKey = (typeof REFUND_STEPS)[number]['key'];

/** The reminder shows this many days before the payout date. */
export const REFUND_REMINDER_DAYS = 14;

export type RefundPlan = { payoutDate: IsoDate; ticked: RefundStepKey[] };

/** First December Payroll release for Therapists: their week of Nov 30 – Dec 6, paid on the Saturday after. */
export const DEFAULT_REFUND_PLAN: RefundPlan = { payoutDate: '2026-12-12' as IsoDate, ticked: [] };

const shift = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Where the refund stands. `entered` counts refunds against the people who
 * have Government Deductions; `payrolls` are the statuses of the Payrolls
 * carrying a refund (null when not generated yet).
 */
export function refundChecklist(input: {
  today: IsoDate;
  plan: RefundPlan;
  novemberFinal: boolean;
  entered: number;
  eligible: number;
  payrolls: readonly ('draft' | 'approved' | 'released' | null)[];
}) {
  const { plan, payrolls } = input;
  const any = input.entered > 0;
  const auto: Record<string, boolean> = {
    'november-final': input.novemberFinal,
    approved: any && payrolls.every((s) => s === 'approved' || s === 'released'),
    released: any && payrolls.every((s) => s === 'released'),
  };
  const steps = REFUND_STEPS.map((s) => ({
    ...s,
    done: s.manual ? plan.ticked.includes(s.key) || (s.key === 'entered' && any && input.entered >= input.eligible) : auto[s.key]!,
    ...(s.key === 'entered' ? { progress: `${input.entered} of ${input.eligible} entered` } : {}),
  }));
  const finished = auto.released!;
  const remindFrom = shift(plan.payoutDate, -REFUND_REMINDER_DAYS);
  const daysLeft = Math.round((Date.parse(`${plan.payoutDate}T00:00:00Z`) - Date.parse(`${input.today}T00:00:00Z`)) / 86_400_000);
  return {
    steps,
    done: steps.filter((s) => s.done).length,
    finished,
    remindFrom,
    daysLeft,
    /** In the Super Admin's Needs Attention from two weeks before payout until every refund is released. */
    remind: !finished && input.today >= remindFrom,
    urgent: !finished && daysLeft <= 3,
  };
}
