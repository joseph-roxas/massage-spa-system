import { describe, expect, it } from 'vitest';
import { addMinutes, overlaps, reservationHold, roomFits, serviceSpanFrom, suggestRoom, suggestTherapist, type RoomInfo, stayOf } from './booking';
import type { RotationEntry } from './rotation';

const rooms: RoomInfo[] = [...Array.from({ length: 7 }, (_, i) => ({ id: i + 1, isFlex: false, active: true })), { id: 8, isFlex: true, active: true }];
const swedish = { id: 'swedish-60', durationMin: 60, isFootType: false };
const foot = { id: 'foot-60', durationMin: 60, isFootType: true };

describe('roomFits', () => {
  it('allows only foot-type Services on the recliner', () => {
    expect(roomFits(rooms[7]!, foot, 'recliner')).toBe(true);
    expect(roomFits(rooms[7]!, swedish, 'recliner')).toBe(false);
    expect(roomFits(rooms[7]!, swedish, 'floor')).toBe(true);
  });

  it('needs a setup for the Flex Room and none for the others', () => {
    expect(roomFits(rooms[7]!, swedish, null)).toBe(false);
    expect(roomFits(rooms[0]!, swedish, null)).toBe(true);
    expect(roomFits(rooms[0]!, swedish, 'floor')).toBe(false);
  });

  it('never uses a closed Room', () => {
    expect(roomFits({ ...rooms[0]!, active: false }, swedish, null)).toBe(false);
  });
});

describe('suggestRoom', () => {
  it('puts foot Services on the recliner and others in Rooms 1–7', () => {
    expect(suggestRoom(rooms, new Set(), foot)).toEqual({ roomId: 8, flexMode: 'recliner' });
    expect(suggestRoom(rooms, new Set(), swedish)).toEqual({ roomId: 1, flexMode: null });
    expect(suggestRoom(rooms, new Set([1, 2]), swedish)).toEqual({ roomId: 3, flexMode: null });
  });

  it('falls back to the Flex Room floor bed, then to nothing', () => {
    expect(suggestRoom(rooms, new Set([1, 2, 3, 4, 5, 6, 7]), swedish)).toEqual({ roomId: 8, flexMode: 'floor' });
    expect(suggestRoom(rooms, new Set([1, 2, 3, 4, 5, 6, 7, 8]), swedish)).toBeNull();
  });

  it('sends a foot Service to a normal Room when the recliner is taken', () => {
    expect(suggestRoom(rooms, new Set([8]), foot)).toEqual({ roomId: 1, flexMode: null });
  });
});

describe('suggestTherapist', () => {
  const now = '2026-11-03T07:00:00.000Z';
  const span = { start: now, end: addMinutes(now, 60) };
  const rotation: RotationEntry[] = [
    { staffId: 'A', position: 1, status: 'in_service', queuedSince: now },
    { staffId: 'B', position: 2, status: 'free', queuedSince: now },
    { staffId: 'C', position: 3, status: 'free', queuedSince: now },
  ];
  const none = new Map();

  it('takes the first free therapist in the Rotation', () => {
    expect(suggestTherapist(rotation, { span }, { requestedId: null, heldSpans: none })).toEqual({ staffId: 'B', reason: 'rotation' });
  });

  it('skips a therapist held for a Scheduled Booking that would clash', () => {
    const held = new Map([['B', [{ start: addMinutes(now, 30), end: addMinutes(now, 120) }]]]);
    expect(suggestTherapist(rotation, { span }, { requestedId: null, heldSpans: held })?.staffId).toBe('C');
    const later = new Map([['B', [{ start: addMinutes(now, 60), end: addMinutes(now, 120) }]]]);
    expect(suggestTherapist(rotation, { span }, { requestedId: null, heldSpans: later })?.staffId).toBe('B');
  });

  it('gives a Requested Therapist priority, but only when free', () => {
    expect(suggestTherapist(rotation, { span }, { requestedId: 'C', heldSpans: none })).toEqual({ staffId: 'C', reason: 'requested' });
    expect(suggestTherapist(rotation, { span }, { requestedId: 'A', heldSpans: none })).toBeNull();
    expect(suggestTherapist(rotation, { span }, { requestedId: 'Z', heldSpans: none })).toBeNull();
  });
});

describe('a named reservation', () => {
  const at = '2026-11-03T09:00:00.000Z';
  const hold = reservationHold(at, 60);
  const rotation: RotationEntry[] = [{ staffId: 'A', position: 1, status: 'free', queuedSince: at }];
  const requested = (startMinBefore: number, durationMin: number) =>
    suggestTherapist(rotation, { span: serviceSpanFrom(addMinutes(at, -startMinBefore), durationMin) }, { requestedId: 'A', heldSpans: new Map(), reservedSpans: new Map([['A', [hold]]]) });

  it('starts holding its Therapist 30 minutes before', () => {
    expect(hold).toEqual({ start: '2026-11-03T08:30:00.000Z', end: '2026-11-03T10:00:00.000Z' });
  });

  it('refuses a 1-hour walk-in an hour before, but allows a 30-minute one', () => {
    expect(requested(60, 60)).toBeNull();
    expect(requested(60, 30)).toEqual({ staffId: 'A', reason: 'requested' });
    expect(requested(45, 30)).toBeNull();
  });

  it('ignores the seconds on the desk clock', () => {
    expect(serviceSpanFrom('2026-11-03T08:00:20.000Z', 30)).toEqual({ start: '2026-11-03T08:00:00.000Z', end: '2026-11-03T08:30:00.000Z' });
  });
});

describe('overlaps', () => {
  it('treats touching spans as not overlapping', () => {
    expect(overlaps({ start: '1', end: '3' }, { start: '3', end: '5' })).toBe(false);
    expect(overlaps({ start: '1', end: '4' }, { start: '3', end: '5' })).toBe(true);
  });
});

describe('stayOf', () => {
  const row = (id: string, parentBookingId: string | null, createdAt: string) => ({ id, parentBookingId, createdAt });
  const rows = [row('a', null, '1'), row('b', 'a', '2'), row('c', 'b', '3'), row('x', null, '1')];
  it('finds the whole stay from any of its Bookings, in order', () => {
    expect(stayOf(rows, 'c').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(stayOf(rows, 'a').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
  it('is just the Booking when nothing was added', () => {
    expect(stayOf(rows, 'x').map((r) => r.id)).toEqual(['x']);
    expect(stayOf(rows, 'nope')).toEqual([]);
  });
});
