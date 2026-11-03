import { describe, expect, it } from 'vitest';
import { formatPeso, percentOf, pesos } from './money';

describe('money', () => {
  it('converts pesos to centavos without float drift', () => {
    expect(pesos(62.5)).toBe(6250);
    expect(pesos(105.63)).toBe(10563);
  });

  it('computes commission percentages to the centavo', () => {
    expect(percentOf(pesos(500), 30)).toBe(pesos(150));
    expect(percentOf(pesos(750), 40)).toBe(pesos(300));
    expect(percentOf(pesos(250), 10)).toBe(pesos(25));
  });

  it('formats pesos for display', () => {
    expect(formatPeso(pesos(1250))).toBe('₱1,250.00');
    expect(formatPeso(pesos(105.63))).toBe('₱105.63');
  });
});
