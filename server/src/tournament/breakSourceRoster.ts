/**
 * THE BREAK PROPOSAL COUNTS THE SAME PEOPLE THE BREAK DOOR COUNTS (2026-09-29).
 *
 * `fn_f06_begin_break` begins a table break only when the proposal names
 * exactly the source's live seats AND exactly its `playing`/`registered`
 * registrations, each seat joined to its registration at the same table and
 * chair with the same chips. The engine built its proposal from the live seats
 * alone, so any registration without a live seat made the door raise a bare
 * `F06_WHOLE_ROSTER_REQUIRED` that named nobody, and the engine could only try
 * again.
 *
 * The common case is a bust not yet recorded: the hand's stack commit takes
 * the seat and zeroes the registration, and the registration stays `playing`
 * until the elimination sweep records it. That is not a disagreement to argue
 * with; it is earlier work, and the answer is to record the bust first. Every
 * other difference is a real disagreement and stays a refusal, now named.
 *
 * This compares what the door compares, from the same two tables, after the
 * source is parked. The door stays the authority; this only stops the engine
 * sending a proposal it can already see will be refused, and says who differs.
 */

export interface BreakSourceSeat {
  readonly id: string;
  readonly user_id: string;
  readonly seat_number: number;
  readonly stack: number | string;
}

export interface BreakSourceRegistration {
  readonly user_id: string;
  readonly status: string;
  readonly chips: number | string | null;
  readonly seat_number: number | null;
}

export interface BreakSourceDisagreement {
  /** Zero-chip `playing` registrations with no live seat: busts not yet recorded. */
  readonly unrecordedBusts: readonly string[];
  /** Every other difference, by kind, each naming the players involved. */
  readonly conflicts: Readonly<Record<string, readonly string[]>>;
  /** One line for the refusal log, naming every player that differs. */
  readonly reason: string;
}

const short = (userId: string): string => userId.slice(0, 8);

/** The door's own tolerance between a seat's stack and its registration's chips. */
const CHIP_TOLERANCE = 0.5;

export function compareBreakSourceRoster(
  seats: readonly BreakSourceSeat[],
  registrations: readonly BreakSourceRegistration[]
): BreakSourceDisagreement | null {
  const conflicts: Record<string, string[]> = {};
  const note = (kind: string, userId: string): void => {
    (conflicts[kind] ??= []).push(userId);
  };
  const unrecordedBusts: string[] = [];

  const seatByUser = new Map<string, BreakSourceSeat>();
  for (const seat of seats) {
    if (seatByUser.has(seat.user_id)) note('seat_repeated', seat.user_id);
    else seatByUser.set(seat.user_id, seat);
  }
  const registrationByUser = new Map<string, BreakSourceRegistration>();
  for (const registration of registrations) {
    if (registrationByUser.has(registration.user_id))
      note('registration_repeated', registration.user_id);
    else registrationByUser.set(registration.user_id, registration);
  }

  for (const [userId, registration] of registrationByUser) {
    const seat = seatByUser.get(userId);
    const chips = Number(registration.chips);
    if (!seat) {
      if (registration.status === 'playing' && Number.isFinite(chips) && chips <= 0)
        unrecordedBusts.push(userId);
      else note('registration_without_seat', userId);
      continue;
    }
    if (
      registration.status !== 'playing' ||
      registration.seat_number !== seat.seat_number ||
      !Number.isFinite(chips) ||
      Math.abs(Number(seat.stack) - chips) > CHIP_TOLERANCE
    )
      note('seat_registration_differ', userId);
  }
  for (const userId of seatByUser.keys()) {
    if (!registrationByUser.has(userId)) note('seat_without_registration', userId);
  }

  const kinds = Object.keys(conflicts).sort();
  if (unrecordedBusts.length === 0 && kinds.length === 0) return null;
  const parts: string[] = [];
  if (unrecordedBusts.length > 0)
    parts.push(`bust_unrecorded=${[...unrecordedBusts].sort().map(short).join(',')}`);
  for (const kind of kinds) parts.push(`${kind}=${[...conflicts[kind]].sort().map(short).join(',')}`);
  return {
    unrecordedBusts: [...unrecordedBusts].sort(),
    conflicts,
    reason: `source_roster_disagrees:${parts.join(';')}`,
  };
}
