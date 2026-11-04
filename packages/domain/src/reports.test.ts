import { describe, expect, it } from 'vitest';
import { BOM, crc32, toCsv, toXlsx } from './export';
import { focGroup, manilaHour, serviceTimes, totalsOf, type Column } from './reports';

const COLS: Column[] = [
  { key: 'name', label: 'Therapist', type: 'text' },
  { key: 'services', label: 'Services', type: 'int' },
  { key: 'commission', label: 'Commission', type: 'money' },
];

describe('report helpers', () => {
  it('totals the number columns', () => {
    expect(totalsOf(COLS, [{ name: 'Ana', services: 3, commission: 45000 }, { name: 'Liza', services: 2, commission: 40000 }])).toEqual({
      name: 'Total',
      services: 5,
      commission: 85000,
    });
  });

  it('reads the start hour in Manila', () => {
    expect(manilaHour('2026-11-03T06:30:00.000Z')).toBe(14);
    expect(manilaHour('2026-11-03T16:10:00.000Z')).toBe(0);
  });

  it('counts Services by start hour, running past midnight', () => {
    const t = serviceTimes([
      { service: 'Swedish', startedAt: '2026-11-03T06:30:00.000Z' }, // 2pm
      { service: 'Swedish', startedAt: '2026-11-03T06:50:00.000Z' }, // 2pm
      { service: 'Thai', startedAt: '2026-11-03T16:10:00.000Z' }, // 12am
      { service: 'Thai', startedAt: '2026-11-03T09:00:00.000Z' }, // 5pm
    ]);
    expect(t.hours).toEqual([14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0]);
    expect(t.rows[0]).toEqual({ service: 'Swedish', counts: { 14: 2 }, total: 2 });
    expect(t.rows[1]).toEqual({ service: 'Thai', counts: { 0: 1, 17: 1 }, total: 2 });
  });

  it('groups FOCs, telling paid and free Vouchers apart', () => {
    expect(focGroup('voucher', 'prepaid')).toBe('voucher_paid');
    expect(focGroup('voucher', 'real')).toBe('voucher_free');
    expect(focGroup('complimentary', 'real')).toBe('complimentary');
    expect(focGroup('senior', 'none')).toBe('senior');
    expect(focGroup('none', 'none')).toBeNull();
  });
});

describe('export', () => {
  it('writes CSV with pesos and quoting', () => {
    const csv = toCsv(COLS, [{ name: 'Ana, LMT', services: 3, commission: 45050 }]);
    expect(csv).toBe(`${BOM}Therapist,Services,Commission\r\n"Ana, LMT",3,450.5\r\n`);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes a zip-based workbook with the sheet inside', () => {
    const bytes = toXlsx('Therapist sales', COLS, [{ name: 'Ana & Co', services: 3, commission: 45000 }]);
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('xl/worksheets/sheet1.xml');
    expect(text).toContain('<t>Ana &amp; Co</t>');
    expect(text).toContain('<c r="C2" s="2"><v>450</v></c>');
  });
});
