import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { RotationRow } from './attendance';

export type BookingStatus = 'scheduled' | 'waiting' | 'in_service' | 'done' | 'cancelled' | 'no_show';

export type Booking = {
  id: string;
  kind: 'walk_in' | 'scheduled';
  status: BookingStatus;
  guestName: string | null;
  guestPhone: string | null;
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
};

export type BoardRoom = { id: number; name: string; isFlex: boolean; active: boolean; booking: Booking | null };

export type Board = {
  day: string;
  now: string;
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
      api<{ id?: string }>(req.path, { method: req.method ?? 'POST', body: req.body ?? {} }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['front-desk'] });
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
  });
}

export const guestLabel = (b: Booking) => b.guestName || 'Walk-in guest';
