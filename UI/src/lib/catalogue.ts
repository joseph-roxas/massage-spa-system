import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export type PriceEntry = { id: string; regularPrice: number; effectiveFrom: string };

export type Service = {
  id: string;
  code: string;
  name: string;
  durationMin: number;
  kind: 'single' | 'combo';
  isFootType: boolean;
  voucherEligible: boolean;
  /** Printed before each Voucher card's number, e.g. "NTL-SM". */
  voucherPrefix: string | null;
  active: boolean;
  sortOrder: number;
  currentPrice: number | null;
  upcomingPrices: PriceEntry[];
  priceHistory: PriceEntry[];
};

export type Promo = {
  id: string;
  name: string;
  serviceId: string;
  percentBp: number;
  startTime: string;
  endTime: string;
  validFrom: string;
  validTo: string;
  active: boolean;
};

export type Addon = { id: string; name: string; price: number; active: boolean };
export type Room = { id: number; name: string; isFlex: boolean; active: boolean };
export type Holiday = { date: string; name: string; type: 'regular' | 'special'; raisesCommission: boolean };

export type Qualification = 'nc2' | 'doh' | 'nuat_thai_trained' | 'experience';

export type Certificate = { id: string; staffId: string; type: 'nc2' | 'doh'; number: string | null; issuedOn: string | null; expiresOn: string | null };

export type StaffMember = {
  id: string;
  firstName: string;
  /** Surname. */
  lastName: string;
  middleName: string | null;
  displayName: string;
  gender: 'female' | 'male' | null;
  birthdate: string | null;
  birthplace: string | null;
  civilStatus: 'single' | 'married' | 'widowed' | 'separated' | null;
  religion: string | null;
  address: string | null;
  email: string | null;
  sssNo: string | null;
  phicNo: string | null;
  tin: string | null;
  pagibigNo: string | null;
  hireDate: string | null;
  qualification: Qualification | null;
  certificates: Certificate[];
  kind: 'therapist' | 'receptionist' | 'reliever';
  therapistClass: 'regular' | 'lmt' | null;
  isOnCall: boolean;
  dailyRate: number | null;
  /** The Receptionist login linked to this record, for My Pay. */
  userId: string | null;
  /** Outside Reliever: paid in cash when the Receptionist returns, or by weekly Payroll. */
  reliefPay: 'on_return' | 'weekly' | null;
  /** Monthly salary basis for SSS, PhilHealth and Pag-IBIG; null for the older fixed weekly amounts. */
  contributionBase: number | null;
  govSss: number;
  govPhic: number;
  govPagibig: number;
  active: boolean;
  hasPin: boolean;
};

export type CommissionRate = {
  id: string;
  therapistClass: 'regular' | 'lmt';
  normalBp: number;
  holidayBp: number;
  effectiveFrom: string;
};

export const useServices = () =>
  useQuery({ queryKey: ['catalogue', 'services'], queryFn: () => api<{ today: string; services: Service[] }>('/catalogue/services') });
export const usePromos = () =>
  useQuery({ queryKey: ['catalogue', 'promos'], queryFn: () => api<{ promos: Promo[] }>('/catalogue/promos') });
export const useAddons = () =>
  useQuery({ queryKey: ['catalogue', 'addons'], queryFn: () => api<{ addons: Addon[] }>('/catalogue/addons') });
export const useRooms = () =>
  useQuery({ queryKey: ['catalogue', 'rooms'], queryFn: () => api<{ rooms: Room[] }>('/catalogue/rooms') });
export const useHolidays = (year: string) =>
  useQuery({
    queryKey: ['catalogue', 'holidays', year],
    queryFn: () => api<{ holidays: Holiday[] }>(`/catalogue/holidays?year=${year}`),
  });
export const useStaff = () =>
  useQuery({ queryKey: ['settings', 'staff'], queryFn: () => api<{ staff: StaffMember[] }>('/settings/staff') });
export const useCommissionRates = () =>
  useQuery({
    queryKey: ['settings', 'commission-rates'],
    queryFn: () => api<{ commissionRates: CommissionRate[] }>('/settings/commission-rates'),
  });
export const usePayRules = () =>
  useQuery({
    queryKey: ['settings', 'pay-rules'],
    queryFn: () => api<{ payRules: Record<string, unknown> }>('/settings/pay-rules'),
  });

/** A write that refreshes everything under `invalidates` when it succeeds. */
export function useSave<TInput>(
  request: (input: TInput) => { path: string; method?: string; body?: unknown },
  invalidates: string,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => {
      const { path, method, body } = request(input);
      return api(path, { method: method ?? 'POST', body: body ?? {} });
    },
    onSuccess: () => {
      for (const key of [invalidates, 'attention']) qc.invalidateQueries({ queryKey: [key] });
    },
  });
}
