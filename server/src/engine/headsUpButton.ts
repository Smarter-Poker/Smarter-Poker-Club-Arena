/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HEADS-UP BUTTON LAW (2026-08-31, Phase 2)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two rules, pulled out of the dealing loop so they can be tested against
 * every seat permutation instead of only the one production happens to hit:
 *
 *   1. THE FIRST BUTTON AT A TWO-HANDED TABLE IS DRAWN, not given to the
 *      lowest occupied seat. Seating is seat-first, so the lowest seat is
 *      whoever arrived first, and heads-up the button IS the small blind:
 *      first to act preflop, last postflop. That is the largest positional
 *      edge in poker, handed out deterministically, in a format that is
 *      frequently decided in a handful of hands.
 *
 *   2. THE BLINDS ADVANCE AND THE BUTTON FOLLOWS (TDA Rule 33, the dead
 *      button). Rotating the button forward is correct at three or more
 *      handed and wrong the instant a table drops to two: seats 1/2/3 with
 *      the button on 1, small 2, big 3 -- seat 1 busts, the button walks to
 *      2, and heads-up the button is the small blind, so seat 3 posts the
 *      big blind for the second hand running. Advancing the BIG BLIND
 *      instead gives seat 2 the big blind and seat 3 the button. A player
 *      may post the small blind twice (that is what makes the button
 *      "dead"); nobody ever posts the big blind twice.
 *
 * Pure, seat-number arithmetic only. No engine state, no I/O.
 */

/** The next occupied seat clockwise. `fromSeat` need not itself be occupied. */
export function nextOccupiedSeat(fromSeat: number, seats: number[]): number {
  const sorted = [...seats].sort((a, b) => a - b);
  if (sorted.length === 0) return -1;
  for (const seat of sorted) {
    if (seat > fromSeat) return seat;
  }
  return sorted[0];
}

/**
 * The button (and therefore the small blind) for a two-handed hand, given the
 * seat that posted the big blind on the previous hand. Returns null when the
 * rule does not apply, and the caller keeps its normal rotation.
 */
export function headsUpButtonSeat(seats: number[], lastBigBlindSeat: number): number | null {
  const sorted = [...new Set(seats)].sort((a, b) => a - b);
  if (sorted.length !== 2) return null;
  if (!Number.isFinite(lastBigBlindSeat) || lastBigBlindSeat <= 0) return null;
  const nextBigBlind = nextOccupiedSeat(lastBigBlindSeat, sorted);
  const button = sorted.find((s) => s !== nextBigBlind);
  return button ?? null;
}

/**
 * The drawn first button. `pick` takes an exclusive maximum and returns an
 * index -- the engine passes secureRandomInt, the same generator the deck
 * uses, because this is a money game and Math.random is a predictable PRNG.
 */
export function drawFirstButtonSeat(
  seats: number[],
  pick: (exclusiveMax: number) => number
): number | null {
  const sorted = [...new Set(seats)].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const i = pick(sorted.length);
  return sorted[Math.min(Math.max(0, Math.floor(i)), sorted.length - 1)];
}
