import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export type ClockStaff = {
  id: string;
  displayName: string;
  kind: 'therapist' | 'receptionist' | 'reliever';
  therapistClass: 'regular' | 'lmt' | null;
  isOnCall: boolean;
  hasPin: boolean;
  clockedInAt: string | null;
  /** Clocked in on a Relief Shift (running the front desk). */
  relieving: boolean;
};

/** The Business Day the Clock-in Screen counts toward, and its Holiday if any. */
export type ClockToday = { day: string; holiday: { name: string; type: 'regular' | 'special' } | null };

/** Whether this browser is the marked Front-desk Device (asked with no one logged in). */
export const useDevice = () => useQuery({ queryKey: ['device'], queryFn: () => api<{ frontDesk: boolean; label: string | null }>('/device'), staleTime: 60_000 });

export type RotationRow = {
  staffId: string;
  displayName: string;
  therapistClass: 'regular' | 'lmt' | null;
  isOnCall: boolean;
  position: number;
  status: 'free' | 'in_service';
  queuedSince: string;
};

export type DtrEntry = {
  id: string;
  staffId: string;
  displayName: string;
  kind: 'therapist' | 'receptionist' | 'reliever';
  businessDay: string;
  clockIn: string;
  clockOut: string | null;
  source: 'pin' | 'manual';
  correctedAt: string | null;
  correctionReason: string | null;
  canEdit: boolean;
  /** The Super Admin has settled this entry, so the desk can't change it. */
  lockedAs?: 'corrected' | 'checked' | null;
  /** A Relief Shift: front-desk time paid at the Minimum Wage Rate. */
  isRelief?: boolean;
};

export const useClockStaff = () =>
  useQuery({
    queryKey: ['attendance', 'clock-staff'],
    queryFn: () => api<{ today: ClockToday; staff: ClockStaff[] }>('/clock/staff'),
    refetchInterval: 30_000,
  });

export const useRotation = () =>
  useQuery({
    queryKey: ['attendance', 'rotation'],
    queryFn: () => api<{ day: string; next: string | null; rotation: RotationRow[] }>('/rotation'),
    refetchInterval: 30_000,
  });

export const useDtr = (day: string) =>
  useQuery({
    queryKey: ['attendance', 'dtr', day],
    queryFn: () => api<{ day: string; entries: DtrEntry[] }>(`/dtr?day=${day}`),
  });

export function usePunch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { staffId: string; pin: string; action: 'in' | 'out'; relief?: boolean }) =>
      api<{
        displayName: string;
        firstName: string;
        action: 'in' | 'out';
        at: string;
        earnings: { from: string; commission: number; services: number } | null;
        /** First clock-in of the day on their birthday. */
        birthday: boolean;
      }>('/clock/punch', {
        body,
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['attendance'] }),
  });
}

/** ISO instant → "HH:MM AM/PM" in Manila. */
export function manilaTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });
}

/** ISO instant → value for <input type="datetime-local">, in Manila time. */
export function toLocalInput(iso: string): string {
  return new Date(new Date(iso).getTime() + 8 * 3600_000).toISOString().slice(0, 16);
}

/** <input type="datetime-local"> value (Manila) → ISO instant. */
export function fromLocalInput(value: string): string {
  return new Date(`${value}:00+08:00`).toISOString();
}

export function hoursBetween(from: string, to: string | null): string {
  if (!to) return '—';
  const min = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000);
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}
