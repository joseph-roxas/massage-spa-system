import type { IsoDate } from './calendar';

/** Digits on a valid government ID number. TIN is 9, or 12 with a branch code. */
export const GOV_ID_DIGITS = { sss: [10], phic: [12], pagibig: [12], tin: [9, 12] } as const;
export type GovId = keyof typeof GOV_ID_DIGITS;

const GOV_ID_NAMES: Record<GovId, string> = { sss: 'SSS', phic: 'PhilHealth', pagibig: 'Pag-IBIG', tin: 'TIN' };

/**
 * A warning when an ID number has the wrong number of digits, or null.
 * Only a warning: a record is saved either way.
 */
export function govIdWarning(id: GovId, value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const digits = value.replace(/\D/g, '').length;
  const allowed: readonly number[] = GOV_ID_DIGITS[id];
  if (allowed.includes(digits)) return null;
  return `${GOV_ID_NAMES[id]} numbers have ${allowed.join(' or ')} digits; this has ${digits}.`;
}

/** A Certificate is flagged this many days before it expires. */
export const CERTIFICATE_WARNING_DAYS = 60;

export type CertificateStatus = 'valid' | 'expiring' | 'expired' | 'no_expiry';

export function certificateStatus(expiresOn: IsoDate | null, today: IsoDate): { status: CertificateStatus; daysLeft: number | null } {
  if (!expiresOn) return { status: 'no_expiry', daysLeft: null };
  const daysLeft = Math.round((Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (daysLeft < 0) return { status: 'expired', daysLeft };
  return { status: daysLeft <= CERTIFICATE_WARNING_DAYS ? 'expiring' : 'valid', daysLeft };
}

/** Only a DOH-licensed Therapist earns the LMT Commission. */
export function lmtProblem(therapistClass: 'regular' | 'lmt' | null, qualification: string | null): string | null {
  if (therapistClass === 'lmt' && qualification !== 'doh') return 'Only a DOH-licensed therapist can be a Licensed Massage Therapist.';
  return null;
}

/** Whether `date` is the birthday of someone born on `birthdate`; a 29 February birthday falls on the 28th in other years. */
export function isBirthday(birthdate: IsoDate | null | undefined, date: IsoDate): boolean {
  if (!birthdate) return false;
  const born = birthdate.slice(5);
  const today = date.slice(5);
  if (born === today) return true;
  const year = Number(date.slice(0, 4));
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return born === '02-29' && today === '02-28' && !leap;
}
