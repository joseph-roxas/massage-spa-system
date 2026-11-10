import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { RotationRow } from './attendance';
import type { BusinessDay, DiscountType } from './sales';

export type BookingStatus = 'scheduled' | 'waiting' | 'in_service' | 'done' | 'cancelled' | 'no_show';

export type Booking = {
  id: string;
  kind: 'walk_in' | 'scheduled';
  status: BookingStatus;
  guestId: string | null;
  guestName: string | null;
  guestPhone: string | null;
  /** From the Guest Record: Visits so far and whether they are a Regular. */
  guestVisits: number | null;
  guestIsRegular: boolean;
  /** An Added Service: the Booking it follows in the same Room. */
  parentBookingId: string | null;
  serviceId: string;
  serviceCode: string;
  serviceName: string;
  serviceKind: 'single' | 'combo';
  durationMin: number;
  /** Minutes added by Top-ups, already in durationMin. */
  topUpMin: number;
  scheduledAt: string | null;
  requestedTherapistId: string | null;
  requestedTherapistName: string | null;
  /** A Late Entry: recorded after it started; createdAt is when. */
  enteredLate: boolean;
  therapistId: string | null;
  therapistName: string | null;
  roomId: number | null;
  flexMode: 'floor' | 'recliner' | null;
  portableTable: boolean;
  notes: string | null;
  startedAt: string | null;
  doneAt: string | null;
  endsAt: string | null;
  createdAt: string;
  /** The checkout, once paid. */
  sale: { id: string; amountDue: number; discountType: DiscountType } | null;
};

export type BoardRoom = { id: number; name: string; isFlex: boolean; active: boolean; booking: Booking | null };

export type Board = {
  day: string;
  now: string;
  /** Null until today's first walk-in, sale or Cash-out. */
  businessDay: BusinessDay | null;
  /** Earlier Business Days nobody closed; these block new activity. */
  unclosed: string[];
  next: string | null;
  rotation: RotationRow[];
  rooms: BoardRoom[];
  bookings: Booking[];
  /** So far today: money received, Guests served, people turned away. */
  today: { sales: number; guests: number; turnedAway: number };
  /** Staff whose birthday it is today. */
  birthdays: string[];
  /** Who is running the front desk on a Relief Shift now. */
  relieving: string[];
};

export type RejectReason = 'no_therapist' | 'too_late' | 'refused_safety';

export const REJECT_REASON_LABELS: Record<RejectReason, string> = {
  no_therapist: 'No therapist free in time',
  too_late: 'Came in too late',
  refused_safety: 'Refused for safety (pregnant, medical condition)',
};

export type Reject = { id: string; reason: RejectReason; createdAt: string };

export const useRejects = () => useQuery({ queryKey: ['front-desk', 'rejects'], queryFn: () => api<{ rejects: Reject[] }>('/rejects') });

export type ReliefOwed = { staffId: string; displayName: string; amount: number; days: string[] };

/** Short-cover Outside Relievers owed Relief pay, paid in cash when the Receptionist returns. */
export const useReliefOwed = (enabled: boolean) =>
  useQuery({ queryKey: ['front-desk', 'relief-pay'], queryFn: () => api<{ owed: ReliefOwed[] }>('/relief-pay'), enabled });

export type Suggestion = {
  therapist: { staffId: string; reason: 'requested' | 'rotation' } | null;
  room: { roomId: number; flexMode: 'floor' | 'recliner' | null } | null;
};

export const useBoard = () =>
  useQuery({ queryKey: ['front-desk'], queryFn: () => api<Board>('/front-desk'), refetchInterval: 15_000 });

export const fetchSuggestion = (id: string) => api<Suggestion>(`/bookings/${id}/suggest`);

/** Any front-desk write; refreshes the board and the Rotation afterwards. */
export function useDeskAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: { path: string; body?: unknown; method?: string }) =>
      api<{ id?: string; startedNext?: string | null }>(req.path, { method: req.method ?? 'POST', body: req.body ?? {} }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['front-desk'] });
      qc.invalidateQueries({ queryKey: ['attendance'] });
      // A Top-up or Service Change at checkout re-prices it.
      qc.invalidateQueries({ queryKey: ['stay'] });
      qc.invalidateQueries({ queryKey: ['quote'] });
    },
  });
}

export const guestLabel = (b: Pick<Booking, 'guestName'>) => b.guestName || 'Walk-in guest';

/** A Scheduled Booking naming its Therapist, not started yet. */
export const isNamedReservation = (b: Pick<Booking, 'kind' | 'requestedTherapistId' | 'status'>) =>
  b.kind === 'scheduled' && !!b.requestedTherapistId && (b.status === 'scheduled' || b.status === 'waiting');
