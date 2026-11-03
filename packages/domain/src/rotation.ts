/** One clock-in/clock-out pair from the DTR. Times are ISO instants. */
export type Shift = { clockIn: string; clockOut: string | null };

/** A Service a therapist performed or is performing today. */
export type ServiceTurn = {
  staffId: string;
  /** The Guest asked for this therapist: serving them out of turn costs no Rotation place. */
  requested: boolean;
  startedAt: string;
  doneAt: string | null;
};

export type RotationTherapist = { staffId: string; shifts: readonly Shift[] };

export type RotationStatus = 'free' | 'in_service';

export type RotationEntry = {
  staffId: string;
  /** 1 = next to take an un-requested Guest. */
  position: number;
  status: RotationStatus;
  /** When this therapist last joined the back of the Rotation. */
  queuedSince: string;
};

/**
 * The Rotation for one Business Day.
 *
 * Only therapists currently clocked in are in it. Each one's place is set by
 * the later of: their latest clock-in, or the moment they finished their latest
 * un-requested Service ("Done" sends them to the back). Requested Services
 * never move anyone. Earliest place goes first; ties keep arrival order.
 */
export function computeRotation(
  therapists: readonly RotationTherapist[],
  turns: readonly ServiceTurn[],
): RotationEntry[] {
  const onDuty = therapists
    .map((t) => {
      const latest = [...t.shifts].sort((a, b) => a.clockIn.localeCompare(b.clockIn)).at(-1);
      return latest && latest.clockOut === null ? { staffId: t.staffId, clockIn: latest.clockIn } : null;
    })
    .filter((t): t is { staffId: string; clockIn: string } => t !== null);

  const rows = onDuty.map(({ staffId, clockIn }) => {
    const mine = turns.filter((s) => s.staffId === staffId);
    let queuedSince = clockIn;
    for (const s of mine) {
      if (!s.requested && s.doneAt && s.doneAt > queuedSince) queuedSince = s.doneAt;
    }
    const busy = mine.some((s) => s.doneAt === null);
    return { staffId, clockIn, queuedSince, status: (busy ? 'in_service' : 'free') as RotationStatus };
  });

  rows.sort((a, b) => a.queuedSince.localeCompare(b.queuedSince) || a.clockIn.localeCompare(b.clockIn));
  return rows.map((r, i) => ({ staffId: r.staffId, position: i + 1, status: r.status, queuedSince: r.queuedSince }));
}

/** Who should take the next un-requested Guest: the first free therapist in the Rotation. */
export function nextInRotation(rotation: readonly RotationEntry[]): RotationEntry | undefined {
  return rotation.find((r) => r.status === 'free');
}
