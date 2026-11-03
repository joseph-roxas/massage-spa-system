import { describe, expect, it } from 'vitest';
import { businessDayOf, manilaInstant } from './business-day';
import { computeRotation, nextInRotation, type RotationTherapist, type ServiceTurn } from './rotation';

/** Manila 2026-11-03 at HH:MM as an ISO instant. */
const at = (hhmm: string) => manilaInstant('2026-11-03', hhmm).toISOString();
const onDuty = (staffId: string, clockIn: string): RotationTherapist => ({
  staffId,
  shifts: [{ clockIn: at(clockIn), clockOut: null }],
});
const order = (rotation: { staffId: string }[]) => rotation.map((r) => r.staffId);

describe('Rotation', () => {
  // T2 arrives first, then T1, then T3.
  const team = [onDuty('T1', '13:50'), onDuty('T2', '13:40'), onDuty('T3', '14:05')];

  it('starts in arrival order', () => {
    const rotation = computeRotation(team, []);
    expect(order(rotation)).toEqual(['T2', 'T1', 'T3']);
    expect(nextInRotation(rotation)?.staffId).toBe('T2');
  });

  it('skips busy therapists without moving them', () => {
    const turns: ServiceTurn[] = [{ staffId: 'T2', requested: false, startedAt: at('14:10'), doneAt: null }];
    const rotation = computeRotation(team, turns);
    expect(order(rotation)).toEqual(['T2', 'T1', 'T3']);
    expect(rotation[0]?.status).toBe('in_service');
    expect(nextInRotation(rotation)?.staffId).toBe('T1');
  });

  it('sends a therapist to the back when they finish an un-requested Service', () => {
    const turns: ServiceTurn[] = [
      { staffId: 'T2', requested: false, startedAt: at('14:10'), doneAt: at('15:10') },
      { staffId: 'T1', requested: false, startedAt: at('14:20'), doneAt: null },
    ];
    const rotation = computeRotation(team, turns);
    expect(order(rotation)).toEqual(['T1', 'T3', 'T2']);
    expect(nextInRotation(rotation)?.staffId).toBe('T3');
  });

  it('keeps a Requested Therapist in place after serving out of turn', () => {
    const turns: ServiceTurn[] = [{ staffId: 'T3', requested: true, startedAt: at('14:10'), doneAt: at('15:10') }];
    expect(order(computeRotation(team, turns))).toEqual(['T2', 'T1', 'T3']);

    const t1Requested: ServiceTurn[] = [{ staffId: 'T1', requested: true, startedAt: at('14:10'), doneAt: at('15:10') }];
    expect(order(computeRotation(team, t1Requested))).toEqual(['T2', 'T1', 'T3']);
  });

  it('orders several finishers by when they finished', () => {
    const turns: ServiceTurn[] = [
      { staffId: 'T2', requested: false, startedAt: at('14:10'), doneAt: at('15:40') },
      { staffId: 'T1', requested: false, startedAt: at('14:20'), doneAt: at('15:20') },
    ];
    expect(order(computeRotation(team, turns))).toEqual(['T3', 'T1', 'T2']);
  });

  it('leaves out therapists who clocked out, and re-joins them at the back', () => {
    const left: RotationTherapist = { staffId: 'T2', shifts: [{ clockIn: at('13:40'), clockOut: at('16:00') }] };
    expect(order(computeRotation([left, onDuty('T1', '13:50')], []))).toEqual(['T1']);

    const back: RotationTherapist = {
      staffId: 'T2',
      shifts: [
        { clockIn: at('13:40'), clockOut: at('16:00') },
        { clockIn: at('17:00'), clockOut: null },
      ],
    };
    expect(order(computeRotation([back, onDuty('T1', '13:50')], []))).toEqual(['T1', 'T2']);
  });

  it('has no one next when everyone is busy', () => {
    const turns: ServiceTurn[] = ['T1', 'T2', 'T3'].map((staffId) => ({ staffId, requested: false, startedAt: at('15:00'), doneAt: null }));
    expect(nextInRotation(computeRotation(team, turns))).toBeUndefined();
  });
});

describe('businessDayOf', () => {
  it('keeps after-midnight activity on the day that opened', () => {
    expect(businessDayOf(manilaInstant('2026-11-04', '01:30'))).toBe('2026-11-03');
    expect(businessDayOf(manilaInstant('2026-11-04', '05:59'))).toBe('2026-11-03');
  });

  it('starts a new Business Day at the cutoff', () => {
    expect(businessDayOf(manilaInstant('2026-11-04', '06:00'))).toBe('2026-11-04');
    expect(businessDayOf(manilaInstant('2026-11-04', '13:55'))).toBe('2026-11-04');
  });

  it('handles month and year ends', () => {
    expect(businessDayOf(manilaInstant('2027-01-01', '00:15'))).toBe('2026-12-31');
  });
});
