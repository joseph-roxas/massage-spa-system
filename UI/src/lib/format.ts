import { formatPeso, pesos, type Centavos } from '@spa/domain';

export const peso = (centavos: number | null | undefined) =>
  centavos == null ? '—' : formatPeso(centavos as Centavos);

/** Pesos typed by a person ("1,250.50") → centavos, or null if not a valid amount. */
export function parsePesos(text: string): number | null {
  const cleaned = text.replace(/[,₱\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return pesos(Number(cleaned));
}

/** Centavos → the plain number a person edits ("1250.50"). */
export const pesosText = (centavos: number) => (centavos / 100).toFixed(2);

/** Basis points → "10%" / "12.5%". */
export const percent = (bp: number) => `${Number((bp / 100).toFixed(2))}%`;

export function duration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = min / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} hr${h === 1 ? '' : 's'}`;
}

export function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00+08:00`).toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** 14:00 → 2:00 PM */
export function clock(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function todayManila(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}
