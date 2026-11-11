import { describe, expect, it } from 'vitest';
import { handoverReminder, isTopUpDay, pettyCashBalance, salesCashAnchor, topUpNeeded, transferDay } from './cash';
import { dayTotals } from './day-close';
import { pesos } from './money';

describe('Petty Cash Fund', () => {
  it('starts at ₱800, goes down with petty Cash-outs and back up with Top-ups', () => {
    expect(pettyCashBalance(0, 0)).toBe(pesos(800));
    expect(pettyCashBalance(pesos(300), pesos(450))).toBe(pesos(650));
    expect(topUpNeeded(pesos(650))).toBe(pesos(150));
    expect(topUpNeeded(pesos(800))).toBe(0);
  });

  it('is topped up on Saturday', () => {
    expect(isTopUpDay('2026-11-14')).toBe(true); // Saturday
    expect(isTopUpDay('2026-11-15')).toBe(false); // Sunday
    expect(isTopUpDay('2026-11-16')).toBe(false); // Monday
  });
});

describe('Sales Cash in the shop', () => {
  it('runs on from the last count: closed day, or a later opening count', () => {
    const closed = { date: '2026-11-04', countedCash: pesos(5000) };
    expect(salesCashAnchor(closed, null)).toEqual({ amount: pesos(5000), fromDay: '2026-11-05' });
    expect(salesCashAnchor(closed, { date: '2026-11-04', amount: pesos(100) })).toEqual({ amount: pesos(5000), fromDay: '2026-11-05' });
    expect(salesCashAnchor(closed, { date: '2026-11-05', amount: pesos(100) })).toEqual({ amount: pesos(100), fromDay: '2026-11-05' });
    expect(salesCashAnchor(null, null).amount).toBe(0);
  });

  it('expects what was there, plus cash taken, less Sales-Cash outs and transfers', () => {
    const t = dayTotals(
      [
        { method: 'cash', amount: pesos(3000) },
        { method: 'gcash', amount: pesos(1000) },
      ],
      [{ amount: pesos(500) }],
      { carriedIn: pesos(5000), transfersOut: pesos(6000) },
    );
    expect(t).toMatchObject({ expectedCash: pesos(1500), expectedGcash: pesos(1000) });
  });

  it('counts a transfer after Day Close toward the next Business Day', () => {
    expect(transferDay('2026-11-04', false)).toBe('2026-11-04');
    expect(transferDay('2026-11-04', true)).toBe('2026-11-05');
  });
});

describe('handover reminder', () => {
  const paid = { salesCash: pesos(9000), payrollReleased: true, laundryPaid: true, pettyCashFull: true };

  it('holds on Thursday and Friday, whatever is paid', () => {
    expect(handoverReminder({ ...paid, today: '2026-11-12' })).toBe('hold'); // Thursday
    expect(handoverReminder({ ...paid, today: '2026-11-13' })).toBe('hold'); // Friday
  });

  it('hands over on Saturday only once Payroll, Laundry and petty cash are all paid', () => {
    const saturday = '2026-11-14';
    expect(handoverReminder({ ...paid, today: saturday })).toBe('hand_over');
    expect(handoverReminder({ ...paid, today: saturday, payrollReleased: false })).toBe('hold');
    expect(handoverReminder({ ...paid, today: saturday, laundryPaid: false })).toBe('hold');
    expect(handoverReminder({ ...paid, today: saturday, pettyCashFull: false })).toBe('hold');
  });

  it('hands over from Sunday to Wednesday whatever has built up, with no Payroll check', () => {
    for (const today of ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18']) {
      expect(handoverReminder({ today, salesCash: pesos(1200), payrollReleased: false, laundryPaid: false, pettyCashFull: false })).toBe('hand_over');
    }
  });

  it('has nothing to remind of with no Sales Cash', () => {
    expect(handoverReminder({ ...paid, today: '2026-11-15', salesCash: 0 })).toBe('none');
  });
});
