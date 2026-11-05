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
  durationMin: number;
  scheduledAt: string | null;
  requestedTherapistId: string | null;
  requestedTherapistName: string | null;
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
};

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
    },
  });
}

export const guestLabel = (b: Pick<Booking, 'guestName'>) => b.guestName || 'Walk-in guest';
