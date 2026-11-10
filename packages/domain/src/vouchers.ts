import type { Centavos } from './money';

/** Buy this many Vouchers for one Service and one more is free (5+1). */
export const BUNDLE_SIZE = 5;

export type VoucherOrder = {
  /** Vouchers the buyer pays for. */
  paid: number;
  /** Free sixth Vouchers earned: one per full Bundle. */
  free: number;
  total: Centavos;
};

/** Vouchers sell at the Regular Price on the day sold; every five bought together earn a free one. */
export function voucherOrder(unitPrice: Centavos, qty: number): VoucherOrder {
  return { paid: qty, free: Math.floor(qty / BUNDLE_SIZE), total: (unitPrice * qty) as Centavos };
}

/** Serials are typed back in at Redemption, so case and stray spaces don't matter. */
export function normalizeSerial(serial: string): string {
  return serial.trim().toUpperCase().replace(/\s+/g, '');
}

/** A serial with only its letters and digits, so "ntl-sm 0271" and "NTLSM0271" both match NTL-SM-0271. */
export function compactSerial(serial: string): string {
  return serial.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The serial printed on a Voucher card, e.g. ("NTL-SM", 271) → "NTL-SM-0271". */
export function cardSerial(prefix: string, cardNo: number): string {
  return `${prefix}-${String(cardNo).padStart(4, '0')}`;
}

/** At most this many cards in one range, so a typo like 271-3200 is caught. */
export const MAX_CARD_RANGE = 500;

/**
 * Card numbers from text such as "271-320, 330 335": ranges and single
 * numbers, any separators. Returns them sorted and de-duplicated, or why not.
 */
export function parseCardNumbers(text: string): number[] | string {
  const out = new Set<number>();
  for (const part of text.split(/[\s,;]+/).filter(Boolean)) {
    const m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(part);
    if (!m) return `"${part}" is not a card number or range like 271-320.`;
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from < 1 || to < from) return `"${part}" is not a valid range.`;
    if (to - from + 1 > MAX_CARD_RANGE) return `"${part}" is more than ${MAX_CARD_RANGE} cards.`;
    for (let n = from; n <= to; n++) out.add(n);
  }
  if (out.size === 0) return 'Enter at least one card number.';
  return [...out].sort((x, y) => x - y);
}

export type VoucherForRedemption = {
  serviceId: string;
  status: 'in_shop' | 'unused' | 'redeemed' | 'used_before_golive' | 'voided';
};

/** Why this Voucher can't pay for `serviceId`, or null if it can. */
export function redemptionProblem(voucher: VoucherForRedemption | null | undefined, serviceId: string): string | null {
  if (!voucher) return 'No voucher has that serial number.';
  if (voucher.status === 'in_shop') return 'This voucher card was never sold.';
  if (voucher.status === 'redeemed') return 'This voucher has already been used.';
  if (voucher.status === 'used_before_golive') return 'This voucher was already used before the system started.';
  if (voucher.status === 'voided') return 'This voucher was cancelled.';
  if (voucher.serviceId !== serviceId) return 'This voucher is for a different service. Vouchers cannot be upgraded.';
  return null;
}

/**
 * Whether redeeming this Voucher is a Real FOC. In a sold Bundle the free
 * ones are whichever are redeemed last: once as many as were paid for have
 * been used. Imported paper Vouchers keep the flag they were entered with.
 */
export function redemptionIsFree(v: { imported: boolean; isFree: boolean; qtyPaid: number | null; redeemedBefore: number }): boolean {
  if (v.imported || v.qtyPaid === null) return v.isFree;
  return v.redeemedBefore >= v.qtyPaid;
}

/** A Bundle's Vouchers in the order used, each marked free if it was redeemed after all the paid ones. */
export function bundleUse<V extends { redeemedAt: string | null }>(qtyPaid: number, vouchers: readonly V[]): (V & { free: boolean })[] {
  const used = vouchers.filter((v) => v.redeemedAt).sort((a, b) => a.redeemedAt!.localeCompare(b.redeemedAt!));
  const unused = vouchers.filter((v) => !v.redeemedAt);
  return [...used.map((v, i) => ({ ...v, free: i >= qtyPaid })), ...unused.map((v) => ({ ...v, free: false }))];
}

/** How the voucher list is filtered by status: the owner's words for which cards to show. */
export const VOUCHER_LIST_FILTERS = {
  unsold: { label: 'Unsold', statuses: ['in_shop'] },
  sold: { label: 'Sold (all)', statuses: ['unused', 'redeemed', 'used_before_golive'] },
  sold_unused: { label: 'Sold, unused', statuses: ['unused'] },
  used: { label: 'Used', statuses: ['redeemed', 'used_before_golive'] },
  voided: { label: 'Cancelled', statuses: ['voided'] },
} as const;
export type VoucherListFilter = keyof typeof VOUCHER_LIST_FILTERS;
