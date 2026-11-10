import { describe, expect, it } from 'vitest';
import { matchOpeningRows, readOpeningSheet } from './opening-count';

describe('readOpeningSheet', () => {
  it('finds the header row, skips blank lines and reads optional Unit and Kind', () => {
    const { rows, problems } = readOpeningSheet([
      ['Opening count, shop'],
      [],
      ['Item', 'Quantity', 'Unit', 'Kind'],
      ['Bath towel', 30, 'pc', 'Reusable supply'],
      [null, null],
      ['  Massage   oil ', '4'],
      ['Aircon', 3, 'unit', 'equipment'],
    ]);
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      { line: 4, name: 'Bath towel', qty: 30, unit: 'pc', kind: 'reusable' },
      { line: 6, name: 'Massage oil', qty: 4 },
      { line: 7, name: 'Aircon', qty: 3, unit: 'unit', kind: 'equipment' },
    ]);
  });

  it('names the lines it cannot read', () => {
    const { rows, problems } = readOpeningSheet([['item', 'qty', 'kind'], ['Tissue', 2.5], [null, 3], ['Basket', 2, 'gadget']]);
    expect(rows).toEqual([]);
    expect(problems).toEqual([
      'Line 2 (Tissue): the Quantity must be a whole number, 0 or more.',
      'Line 3: the Item is blank.',
      'Line 4 (Basket): Kind must be Consumable, Reusable supply or Equipment.',
    ]);
  });

  it('needs an Item and a Quantity column', () => {
    expect(readOpeningSheet([['Name', 'Count']]).problems).toHaveLength(1);
  });
});

describe('matchOpeningRows', () => {
  const catalog = [
    { id: 'oil', name: 'Massage oil', unit: 'gal' },
    { id: 'alc-l', name: 'Alcohol', unit: 'liter' },
    { id: 'alc-gal', name: 'Alcohol', unit: 'gal' },
  ];

  it('matches names ignoring case, adds up repeated lines, and makes new Items', () => {
    const out = matchOpeningRows(
      [
        { line: 2, name: 'massage OIL', qty: 3 },
        { line: 3, name: 'Massage oil', qty: 1 },
        { line: 4, name: 'Hot stone', qty: 20, unit: 'pc', kind: 'reusable' },
        { line: 5, name: 'hot stone', qty: 4, unit: 'PC', kind: 'reusable' },
      ],
      catalog,
    );
    expect(out).toEqual([
      { line: 2, status: 'matched', itemId: 'oil', name: 'Massage oil', unit: 'gal', qty: 4 },
      { line: 4, status: 'new', name: 'Hot stone', unit: 'pc', kind: 'reusable', qty: 24 },
    ]);
  });

  it('asks for the Unit when two Items share a name, and for Unit and Kind on a new Item', () => {
    const out = matchOpeningRows(
      [
        { line: 2, name: 'Alcohol', qty: 1 },
        { line: 3, name: 'Alcohol', qty: 2, unit: 'Liter' },
        { line: 4, name: 'Rice', qty: 1, unit: 'kg' },
      ],
      catalog,
    );
    expect(out.map((m) => m.status)).toEqual(['problem', 'matched', 'problem']);
    expect(out[1]).toMatchObject({ itemId: 'alc-l', qty: 2 });
  });
});
