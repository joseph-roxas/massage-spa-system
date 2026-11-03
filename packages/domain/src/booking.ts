import type { RotationEntry } from './rotation';

export type FlexMode = 'floor' | 'recliner';

export type RoomInfo = { id: number; isFlex: boolean; active: boolean };
export type ServiceInfo = { id: string; durationMin: number; isFootType: boolean };

/** A time range [start, end) as ISO instants. */
export type Span = { start: string; end: string };

export function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

export function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

/** Whether a Service can be done in a Room set up a given way. */
export function roomFits(room: RoomInfo, service: ServiceInfo, flexMode: FlexMode | null): boolean {
  if (!room.active) return false;
  if (!room.isFlex) return flexMode === null;
  if (flexMode === null) return false;
  return flexMode === 'floor' || service.isFootType;
}

/**
 * The Room to offer for a Service, given which Rooms are taken right now.
 * Foot-type Services go to the Flex Room's recliner first (that's what it is
 * for); everything else fills the floor-bed Rooms before using the Flex Room.
 */
export function suggestRoom(
  rooms: readonly RoomInfo[],
  occupiedRoomIds: ReadonlySet<number>,
  service: ServiceInfo,
): { roomId: number; flexMode: FlexMode | null } | null {
  const free = rooms.filter((r) => r.active && !occupiedRoomIds.has(r.id)).sort((a, b) => a.id - b.id);
  const flex = free.find((r) => r.isFlex);
  const plain = free.find((r) => !r.isFlex);
  if (service.isFootType && flex) return { roomId: flex.id, flexMode: 'recliner' };
  if (plain) return { roomId: plain.id, flexMode: null };
  if (flex) return { roomId: flex.id, flexMode: 'floor' };
  return null;
}

export type TherapistSuggestion = { staffId: string; reason: 'requested' | 'rotation' };

/**
 * Who should take this Guest now.
 *
 * A Requested Therapist always wins, if they are on duty and free. Otherwise
 * it is the first free therapist in the Rotation who isn't held for a
 * Scheduled Booking that would start before this Service ends.
 */
export function suggestTherapist(
  rotation: readonly RotationEntry[],
  service: { span: Span },
  options: { requestedId: string | null; heldSpans: ReadonlyMap<string, readonly Span[]> },
): TherapistSuggestion | null {
  const free = (id: string) => rotation.some((r) => r.staffId === id && r.status === 'free');
  if (options.requestedId) {
    return free(options.requestedId) ? { staffId: options.requestedId, reason: 'requested' } : null;
  }
  for (const r of rotation) {
    if (r.status !== 'free') continue;
    const held = options.heldSpans.get(r.staffId) ?? [];
    if (held.some((h) => overlaps(h, service.span))) continue;
    return { staffId: r.staffId, reason: 'rotation' };
  }
  return null;
}
