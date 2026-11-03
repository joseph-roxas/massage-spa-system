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

// No 0/O, 1/I/L: serials are read off paper.
const SERIAL_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** A new serial such as "SWE-7K3M9P", from the Service code and random bytes. */
export function newSerial(serviceCode: string, random: Uint8Array): string {
  const body = Array.from(random.slice(0, 6), (b) => SERIAL_ALPHABET[b % SERIAL_ALPHABET.length]).join('');
  return `${normalizeSerial(serviceCode)}-${body}`;
}

export type VoucherForRedemption = {
  serviceId: string;
  status: 'unused' | 'redeemed' | 'voided';
};

/** Why this Voucher can't pay for `serviceId`, or null if it can. */
export function redemptionProblem(voucher: VoucherForRedemption | null | undefined, serviceId: string): string | null {
  if (!voucher) return 'No voucher has that serial number.';
  if (voucher.status === 'redeemed') return 'This voucher has already been used.';
  if (voucher.status === 'voided') return 'This voucher was cancelled.';
  if (voucher.serviceId !== serviceId) return 'This voucher is for a different service. Vouchers cannot be upgraded.';
  return null;
}
