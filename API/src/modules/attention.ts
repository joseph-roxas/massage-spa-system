import { Hono } from 'hono';
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { businessDayOf, certificateStatus, previousQuarter, quarterOf } from '@spa/domain';
import { cashTransfers, certificates, expenses, staff, takeoutRequests, turnovers } from '@spa/db';
import { dtrToReviewCount } from './attendance';
import type { AuthedEnv } from '../env';
import { requireAuth, requireCapability } from '../auth/middleware';
import { quarterStatus } from './finance';

export type AttentionItem = {
  key: string;
  /** `urgent` items are overdue or expired. */
  tone: 'urgent' | 'normal';
  title: string;
  detail: string | null;
  link: string;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Everything waiting on the Super Admin, most urgent first; each item links to where it is acted on. */
export const attentionRoutes = new Hono<AuthedEnv>().get('/attention', requireAuth, requireCapability('settings.manage'), async (c) => {
  const db = c.var.db;
  const today = businessDayOf(new Date());
  const [requests, shortfalls, handovers, people, certs, drafts, tax, dtrToReview] = await Promise.all([
    db.select({ id: takeoutRequests.id, level: takeoutRequests.level }).from(takeoutRequests).where(isNull(takeoutRequests.resolvedAt)),
    db
      .select({ id: turnovers.id })
      .from(turnovers)
      .where(and(isNotNull(turnovers.receivedAt), lt(turnovers.receivedQty, turnovers.qty), isNull(turnovers.shortfallResolvedAt))),
    db.select({ amount: cashTransfers.amount }).from(cashTransfers).where(and(eq(cashTransfers.kind, 'handover'), isNull(cashTransfers.confirmedAt))),
    db.select().from(staff).where(eq(staff.active, true)),
    db.select().from(certificates),
    db.select({ n: sql<number>`count(*)` }).from(expenses).where(eq(expenses.status, 'pending')).get(),
    quarterStatus(db, previousQuarter(quarterOf(today))),
    dtrToReviewCount(db),
  ]);

  const items: AttentionItem[] = [];

  if (!tax.filing) {
    items.push({
      key: 'percentage-tax',
      tone: tax.daysLeft <= 7 ? 'urgent' : 'normal',
      title: `File 2551Q for ${tax.quarter}`,
      detail: `₱${(tax.tax / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })} · ${tax.daysLeft < 0 ? `${-tax.daysLeft} days late` : tax.daysLeft === 0 ? 'due today' : `due in ${plural(tax.daysLeft, 'day')}`}`,
      link: '/finance',
    });
  }

  if (handovers.length) {
    const total = handovers.reduce((s, h) => s + h.amount, 0);
    items.push({
      key: 'handovers',
      tone: 'normal',
      title: `Confirm ${plural(handovers.length, 'cash handover')}`,
      detail: `₱${(total / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })} handed over, waiting for you`,
      link: '/cash',
    });
  }

  if (requests.length) {
    const out = requests.filter((r) => r.level === 'out').length;
    items.push({
      key: 'takeout-requests',
      tone: out ? 'urgent' : 'normal',
      title: `${plural(requests.length, 'item request')} from the shop`,
      detail: out ? `${out} out of stock` : 'Running low',
      link: '/inventory?tab=requests',
    });
  }

  if (shortfalls.length) {
    items.push({ key: 'shortfalls', tone: 'normal', title: `${plural(shortfalls.length, 'turnover')} arrived short`, detail: 'Say whether the rest is still in storage or lost', link: '/inventory?tab=requests' });
  }

  // Certificates of active Therapists, expired or within 60 days.
  const therapists = people.filter((p) => p.kind === 'therapist');
  for (const p of therapists) {
    for (const cert of certs.filter((x) => x.staffId === p.id)) {
      const { status, daysLeft } = certificateStatus(cert.expiresOn, today);
      if (status !== 'expired' && status !== 'expiring') continue;
      const what = cert.type === 'doh' ? 'DOH licence' : 'NC-II';
      items.push({
        key: `certificate-${cert.id}`,
        tone: status === 'expired' ? 'urgent' : 'normal',
        title: `${p.displayName}'s ${what} ${status === 'expired' ? 'has expired' : `expires in ${plural(daysLeft!, 'day')}`}`,
        detail: status === 'expired' && cert.type === 'doh' && p.therapistClass === 'lmt' ? 'Still paid as an LMT: change the class if the licence is not renewed' : null,
        link: '/settings/staff',
      });
    }
  }

  // Government IDs missing for anyone who should be contributing (not On-call Therapists or Outside Relievers).
  const missing = people
    .filter((p) => !p.isOnCall && p.kind !== 'reliever')
    .map((p) => ({ name: p.displayName, ids: [!p.sssNo?.trim() && 'SSS', !p.phicNo?.trim() && 'PhilHealth', !p.pagibigNo?.trim() && 'Pag-IBIG'].filter(Boolean) }))
    .filter((p) => p.ids.length);
  if (missing.length) {
    items.push({
      key: 'government-ids',
      tone: 'normal',
      title: `Government IDs missing for ${plural(missing.length, 'staff member')}`,
      detail: missing.map((p) => `${p.name}: ${p.ids.join(', ')}`).join(' · '),
      link: '/settings/staff',
    });
  }

  const incomplete = people.filter((p) => p.kind !== 'reliever' && (!p.gender || !p.birthdate || !p.hireDate));
  if (incomplete.length) {
    items.push({
      key: 'personal-records',
      tone: 'normal',
      title: `${plural(incomplete.length, 'staff record')} incomplete`,
      detail: incomplete.map((p) => p.displayName).join(', '),
      link: '/settings/staff',
    });
  }

  const pending = Number(drafts?.n ?? 0);
  if (dtrToReview) {
    items.push({ key: 'dtr-review', tone: 'normal', title: `${plural(dtrToReview, 'time record')} to review`, detail: 'Added by hand, corrected, or never clocked out', link: '/dtr?tab=review' });
  }
  if (pending) items.push({ key: 'expense-drafts', tone: 'normal', title: `${plural(pending, 'expense')} to confirm`, detail: 'Royalty, employer contributions and recurring bills', link: '/expenses' });

  items.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'urgent' ? -1 : 1));
  return c.json({ items });
});
