/** Money is always an integer number of centavos. */
export type Centavos = number & { readonly __brand: 'Centavos' };

export function pesos(amount: number): Centavos {
  return Math.round(amount * 100) as Centavos;
}

/** Applies a percentage, rounding half away from zero to the nearest centavo. */
export function percentOf(base: Centavos, pct: number): Centavos {
  const raw = (base * pct) / 100;
  return (Math.sign(raw) * Math.round(Math.abs(raw))) as Centavos;
}

export function formatPeso(value: Centavos): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 100).toLocaleString('en-PH');
  const cents = String(abs % 100).padStart(2, '0');
  return `${sign}₱${whole}.${cents}`;
}
