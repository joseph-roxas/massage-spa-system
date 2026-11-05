import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export type StatutoryType = 'senior' | 'pwd';
export type RegularRule = { visits: number; days: number };

export type GuestListed = {
  id: string;
  name: string;
  phone: string | null;
  statutoryType: StatutoryType | null;
  /** The saved SC/PWD ID, showing its last four characters only. */
  statutoryIdMasked: string | null;
  visits: number;
  lastVisit: string | null;
  recentVisits: number;
  isRegular: boolean;
  avgDaysBetween: number | null;
};

export type GuestDetail = {
  guest: GuestListed & { statutoryIdNo: string | null; mergedInto: string | null };
  visits: { day: string; serviceName: string; therapistName: string; amountDue: number; discountType: string }[];
  vouchers: { id: string; day: string; serviceName: string; qtyPaid: number; qtyFree: number; total: number; status: string }[];
};

export const STATUTORY_LABEL: Record<StatutoryType, string> = { senior: 'Senior Citizen', pwd: 'PWD' };

export const useGuests = (q: string, enabled = true) =>
  useQuery({
    queryKey: ['guests', 'list', q],
    queryFn: () => api<{ guests: GuestListed[]; rule: RegularRule }>(`/guests${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    enabled,
    placeholderData: (prev) => prev,
  });

export const useGuest = (id: string | null | undefined) =>
  useQuery({ queryKey: ['guests', 'one', id], queryFn: () => api<GuestDetail>(`/guests/${id}`), enabled: !!id });

export function useGuestAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: { path: string; body?: unknown; method?: string }) => api<{ id?: string; guestId?: string | null }>(req.path, { method: req.method ?? 'POST', body: req.body ?? {} }),
    onSettled: () => {
      for (const key of ['guests', 'front-desk', 'settings']) qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

/** Visits in words, e.g. "Regular · 5 visits". */
export function visitsLabel(g: Pick<GuestListed, 'visits' | 'isRegular'>): string {
  const visits = g.visits === 0 ? 'first visit' : `${g.visits} ${g.visits === 1 ? 'visit' : 'visits'}`;
  return g.isRegular ? `Regular · ${visits}` : visits;
}
