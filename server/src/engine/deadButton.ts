/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEAD BUTTON RULE HOLDS AT EVERY TABLE SIZE (2026-09-25, TDA Rule 30)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * headsUpButton.ts carries the two-handed half of the rule: the big blind
 * advances and the button follows. The dealing loop applied it ONLY at two
 * players. At three or more it still rotated the BUTTON to the next occupied
 * seat, which is the "moving button" convention, and a tournament table is
 * not played that way. Seats 1..6, button 2, small blind 3, big blind 4, and
 * seat 3 busts between hands:
 *
 *   moving button   button 4, small 5, big 6   seat 4 posts the big blind and
 *                                              holds the button next hand,
 *                                              seat 5 goes from UTG straight
 *                                              to the big blind: two players
 *                                              skip a small blind
 *   this rule       button 3 (dead), small 4, big 5
 *
 * When the BIG blind busted instead (seat 4) the moving button gave seat 5
 * the small blind and then the button, and it never posted a big blind that
 * orbit. When a balanced-in player took an empty seat between the button and
 * the small blind, the moving button handed them the button and the two
 * players behind them posted the small and the big blind twice running.
 *
 * The rule the rest of poker uses, and the one every major online room and
 * the TDA (Rule 30, "dead button") apply at every table size:
 *
 *   1. The BIG BLIND advances exactly one live seat every hand.
 *   2. The SMALL BLIND is the seat that posted the big blind last hand. If
 *      that seat has emptied, the small blind is DEAD: nobody posts it.
 *   3. The BUTTON is the seat that held the small blind last hand, whether or
 *      not anyone still sits there (a dead button). The one exception is a
 *      player who has since taken an empty seat between that seat and the
 *      small blind: the button then goes to them, so it never sits behind a
 *      live player, and the arrival rule bills them a big blind to enter.
 *
 * Nobody posts the big blind twice, nobody skips a blind, and the button
 * never moves backwards or stays put. Heads-up keeps its own rule (the button
 * IS the small blind), so this returns null at two seats and the caller keeps
 * headsUpButtonSeat.
 *
 * Pure, seat-number arithmetic only. No engine state, no I/O.
 */
import { nextOccupiedSeat } from './headsUpButton.js';

export interface BlindSeats {
  /** Where the button sits. May be an empty seat: a dead button. */
  button: number;
  /** The small blind SEAT, occupied or not. An arrival here owes a blind. */
  smallBlindSeat: number;
  /** The seat that posts the small blind, or null when it is dead. */
  smallBlind: number | null;
  /** The seat that posts the big blind. Always occupied. */
  bigBlind: number;
}

export interface LastBlindSeats {
  /** The small blind seat of the previous hand (the button itself heads-up). */
  smallBlind: number;
  /** The seat that posted the big blind on the previous hand. */
  bigBlind: number;
}

/** The nearest candidate counter-clockwise of `from`, wrapping. */
function closestCounterClockwise(from: number, candidates: number[]): number {
  const sorted = [...new Set(candidates)].sort((a, b) => a - b);
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i] < from) return sorted[i];
  }
  return sorted[sorted.length - 1];
}

/**
 * The button and both blinds for a hand of three or more, given the seats
 * that are occupied now and where the blinds sat on the previous hand.
 * Returns null when the rule does not apply (fewer than three seats, or no
 * previous blinds to advance from) and the caller keeps its normal rotation.
 */
export function deadButtonPositions(seats: number[], last: LastBlindSeats): BlindSeats | null {
  const sorted = [...new Set(seats.filter((s) => Number.isFinite(s) && s > 0))].sort(
    (a, b) => a - b
  );
  if (sorted.length < 3) return null;
  if (!Number.isFinite(last.bigBlind) || last.bigBlind <= 0) return null;
  if (!Number.isFinite(last.smallBlind) || last.smallBlind <= 0) return null;

  const bigBlind = nextOccupiedSeat(last.bigBlind, sorted);
  const smallBlindSeat = last.bigBlind;
  const smallBlind = sorted.includes(smallBlindSeat) ? smallBlindSeat : null;
  // The last seat before the small blind that is occupied now or held the
  // small blind last hand. The two blind seats themselves are never the
  // button: after a heads-up hand the old button/small-blind seat can be the
  // seat the big blind has just advanced to.
  const button = closestCounterClockwise(
    smallBlindSeat,
    [...sorted, last.smallBlind].filter((s) => s !== smallBlindSeat && s !== bigBlind)
  );
  return { button, smallBlindSeat, smallBlind, bigBlind };
}
