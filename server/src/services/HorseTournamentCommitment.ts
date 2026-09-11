/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A HORSE LEAVES CASH FOR ITS TOURNAMENT (2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Until today a tournament booking counted as one of a player's four games
 * from the moment it was made, so the database never let a booked player take
 * a chair it would have to give back: a horse registered for Sunday's Main
 * Event held that slot from Thursday. It kept 217 horses off the cash floor
 * for events up to 68 hours away, and migration 20260906144448 narrowed the
 * count to bookings that start within the hour (HorseGameLoad.ts mirrors it).
 *
 * That opens one gap, and this module closes it. A horse may now sit at four
 * cash tables while its tournament is two hours out. When the tournament
 * starts, `fn_enforce_four_table_limit` still refuses a fifth LIVE seat - the
 * client shows four tabs, and that invariant does not move - so the horse
 * would miss the atomic launch admission while a cash session kept the fourth
 * slot occupied. A person does not do that. A person with a
 * tournament in an hour finishes the cash session they have been in longest,
 * gets up in good time, and is in their seat when the cards go in the air.
 *
 * So: for every horse whose LIVE SEATS plus IMMINENT BOOKINGS exceed the
 * platform's four, this decides which cash seats it gets up from, and when.
 * Between sixty and fifteen minutes out the departure is a hazard spread
 * evenly across the window, one seat per cycle, so a room of horses does not
 * stand up in unison at :00. Inside fifteen minutes it is certain: every
 * excess seat is vacated this cycle. A seat-first booking with no start time
 * is a game that starts when it fills, so it is treated as starting now.
 *
 * The seat it leaves is the one it has held LONGEST, at a table with no
 * person at it when there is a choice - a human's game is thinned last, the
 * same courtesy every other rotator departure extends. The leave goes through
 * `engine.leaveTable`, the door a human uses: hand-boundary safe, cashed out
 * at the end of the hand, never a seat-row deletion.
 *
 * This is not a horse rule (CLAUDE.md 10.5). The fleet is the horse's browser;
 * this is the horse reading its own lobby and leaving when a person would.
 *
 * Pure, so it can be proven without a database; the wiring is in
 * HorseSessionRotator and pinned by test against the source.
 */
import { BOOKING_COUNTS_WITHIN_MS, CONCURRENT_GAME_LIMIT } from './HorseGameLoad.js';

/** The window inside which a booking is a game - the database's window. */
export const LEAVE_FOR_TOURNAMENT_FROM_MS = BOOKING_COUNTS_WITHIN_MS;
/** Inside this the departure is certain, not a hazard. Fifteen minutes is
 *  enough for a hand to finish and the cash-out to settle before the first
 *  deal, and short enough that the horse is not idle in the lobby. */
export const LEAVE_FOR_TOURNAMENT_BY_MS = 15 * 60 * 1000;

export interface CommittedCashSeat {
  tableId: string;
  /** Epoch ms the horse sat down here. */
  joinedAtMs: number;
  /** A person is seated at this table. */
  humanPresent: boolean;
}

export interface ImminentBooking {
  tournamentId: string;
  /** Epoch ms of the start; null is seat-first and starts when it fills. */
  startMs: number | null;
}

export interface TournamentCommitment {
  /** This horse's live cash seats the rotator may stand it up from. */
  cashSeats: readonly CommittedCashSeat[];
  /** EVERY live seat the horse holds, cash and tournament, the way clause (1)
   *  of `fn_concurrent_game_load` counts them. Never below cashSeats.length. */
  liveSeatsTotal: number;
  /** Bookings that count as a game right now (inside the window, and not for
   *  a tournament the horse already holds a seat in). */
  imminentBookings: readonly ImminentBooking[];
  nowMs: number;
  /** The rotator's cycle, so the hazard is per cycle. */
  cycleMs: number;
  /** One draw in [0, 1) for the hazard. */
  random: number;
}

export interface CommitmentVerdict {
  /** How many cash seats the horse must be out of before the earliest start. */
  excess: number;
  /** Minutes until the earliest imminent start; 0 for seat-first. */
  minutesToStart: number;
  /** The seats to leave THIS cycle, in the order to leave them. */
  leaveNow: CommittedCashSeat[];
  reason: 'no_commitment' | 'no_excess' | 'hazard_held' | 'hazard_fired' | 'certain';
}

/** Seats in the order a person would give them up: the table with no human
 *  first, then the seat held longest. */
export function seatsInLeavingOrder(seats: readonly CommittedCashSeat[]): CommittedCashSeat[] {
  return [...seats].sort((a, b) => {
    if (a.humanPresent !== b.humanPresent) return a.humanPresent ? 1 : -1;
    return a.joinedAtMs - b.joinedAtMs;
  });
}

export function tournamentCommitmentVerdict(s: TournamentCommitment): CommitmentVerdict {
  const imminent = s.imminentBookings.filter(
    (b) => b.startMs === null || b.startMs <= s.nowMs + LEAVE_FOR_TOURNAMENT_FROM_MS
  );
  if (imminent.length === 0) {
    return { excess: 0, minutesToStart: Infinity, leaveNow: [], reason: 'no_commitment' };
  }
  const liveSeats = Math.max(s.liveSeatsTotal, s.cashSeats.length);
  const excess = Math.max(0, liveSeats + imminent.length - CONCURRENT_GAME_LIMIT);
  const earliest = Math.min(...imminent.map((b) => (b.startMs === null ? s.nowMs : b.startMs)));
  const msToStart = Math.max(0, earliest - s.nowMs);
  const minutesToStart = msToStart / 60_000;
  if (excess === 0) {
    return { excess, minutesToStart, leaveNow: [], reason: 'no_excess' };
  }
  /* Only cash seats can be given up here; a tournament seat is left by
     busting. If the excess is all tournament seats there is nothing to do. */
  const giveable = seatsInLeavingOrder(s.cashSeats);
  const mustLeave = Math.min(excess, giveable.length);
  if (mustLeave === 0) {
    return { excess, minutesToStart, leaveNow: [], reason: 'no_excess' };
  }
  if (msToStart <= LEAVE_FOR_TOURNAMENT_BY_MS) {
    return { excess, minutesToStart, leaveNow: giveable.slice(0, mustLeave), reason: 'certain' };
  }
  /* The hazard: one seat per cycle, spread evenly over what is left of the
     window before the certain point. With N cycles remaining the chance this
     cycle is 1/N, so a horse that must give up one seat leaves at a uniformly
     random moment inside the window, and a room of them does not stand up
     together. A horse that must give up more than one is pushed harder, so
     it is not still holding three excess seats at the certain point. */
  const remaining = msToStart - LEAVE_FOR_TOURNAMENT_BY_MS;
  const cyclesLeft = Math.max(1, remaining / Math.max(1, s.cycleMs));
  const p = Math.min(1, mustLeave / cyclesLeft);
  if (s.random < p) {
    return { excess, minutesToStart, leaveNow: giveable.slice(0, 1), reason: 'hazard_fired' };
  }
  return { excess, minutesToStart, leaveNow: [], reason: 'hazard_held' };
}
