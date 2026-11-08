import { describe, expect, it } from 'vitest';
import { pesos } from './money';
import { topUpPrice, topUpRule } from './topups';
import type { Centavos } from './money';

const single = (id: string, durationMin: number) => ({ id, kind: 'single' as const, durationMin });
const list: Record<string, Centavos> = { 'foot-30': pesos(250), 'back-30': pesos(250), 'head-30': pesos(260) };
const priceOf = (id: string) => list[id];

describe('Top-up price', () => {
  it('is half a 1-hour Service', () => {
    expect(topUpPrice(topUpRule(single('swedish-60', 60))!, pesos(500), null, priceOf)).toBe(pesos(250));
    expect(topUpPrice(topUpRule(single('bodyscrub-60', 60))!, pesos(600), null, priceOf)).toBe(pesos(300));
  });

  it('is the set 30-minute price for Foot and Back at either length', () => {
    expect(topUpPrice(topUpRule(single('foot-60', 60))!, pesos(450), null, priceOf)).toBe(pesos(250));
    expect(topUpPrice(topUpRule(single('back-60', 60))!, pesos(450), null, priceOf)).toBe(pesos(250));
    expect(topUpPrice(topUpRule(single('foot-30', 30))!, pesos(250), null, priceOf)).toBe(pesos(250));
  });

  it('is the chosen 30-minute massage on a 1.5-hour Service', () => {
    const rule = topUpRule(single('aroma-90', 90))!;
    expect(rule).toEqual({ kind: 'pick_part' });
    expect(topUpPrice(rule, pesos(700), 'head', priceOf)).toBe(pesos(260));
    expect(topUpPrice(rule, pesos(700), 'foot', priceOf)).toBe(pesos(250));
    expect(topUpPrice(rule, pesos(700), null, priceOf)).toBeNull();
  });

  it('does not exist for a Combo', () => {
    expect(topUpRule({ id: 'c1', kind: 'combo', durationMin: 90 })).toBeNull();
  });
});
