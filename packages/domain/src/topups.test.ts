import { describe, expect, it } from 'vitest';
import { pesos } from './money';
import { topUpHourService, topUpPrice, topUpRule, topUpStepPrices, topUpTotal } from './topups';
import type { Centavos } from './money';

const single = (id: string, durationMin: number) => ({ id, kind: 'single' as const, durationMin });
const list: Record<string, Centavos> = { 'foot-30': pesos(250), 'back-30': pesos(250), 'head-30': pesos(260) };
const priceOf = (id: string) => list[id];

describe('full extra hours', () => {
  const foot = topUpRule(single('foot-60', 60))!;

  it('cost the 1-hour price of Foot and Back, not two 30-minute prices', () => {
    expect(topUpHourService(foot, null)).toBe('foot-60');
    expect(topUpTotal(1, pesos(250), pesos(450))).toBe(pesos(250));
    expect(topUpTotal(2, pesos(250), pesos(450))).toBe(pesos(450));
    expect(topUpTotal(3, pesos(250), pesos(450))).toBe(pesos(700));
    expect(topUpTotal(4, pesos(250), pesos(450))).toBe(pesos(900));
  });

  it('apply to the foot or back massage added to a 1.5-hour Service, but head has no 1-hour price', () => {
    const rule = topUpRule(single('aroma-90', 90))!;
    expect(topUpHourService(rule, 'foot')).toBe('foot-60');
    expect(topUpHourService(rule, 'head')).toBeNull();
  });

  it('do not change a Service priced at half', () => {
    const rule = topUpRule(single('swedish-60', 60))!;
    expect(topUpHourService(rule, null)).toBeNull();
    expect(topUpTotal(2, pesos(250), null)).toBe(pesos(500));
  });

  it('split across the steps and still add up', () => {
    const sum = (n: number[]) => n.reduce((a, b) => a + b, 0);
    expect(topUpStepPrices(1, pesos(250), pesos(450))).toEqual([pesos(250)]);
    expect(sum(topUpStepPrices(2, pesos(250), pesos(450)))).toBe(pesos(450));
    expect(sum(topUpStepPrices(3, pesos(250), pesos(450)))).toBe(pesos(700));
    expect(sum(topUpStepPrices(4, 25001, 45001))).toBe(90002);
    expect(topUpStepPrices(3, pesos(250), null)).toEqual([pesos(250), pesos(250), pesos(250)]);
  });
});

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
