/**
 * THE DIAMOND WHEEL v4 LAW, GENERATED, NEVER HAND EDITED.
 *
 * Produced by `python3 scripts/diamond-spins/wheel-v4-follow-matrix.py --ts`,
 * which also derives and proves it (owner ruling 2026-09-21, R2/R12/R13/R15).
 * The migration installs the same numbers, from the same script, so the
 * browser can recompute a spin without trusting the receipt it is checking.
 *
 * WHEEL_V4_WEIGHTS is the base law W out of 100000. WHEEL_V4_FOLLOW[i] is the
 * law used by the spin AFTER ord i+1: symmetric, zero on the diagonal, and
 * summing to W[i], which is what keeps every spin's unconditional law exactly
 * W and so the mix exactly 50/30/20 and the payback exactly 0.8.
 */

export const WHEEL_V4_TOTAL = 100000;

export const WHEEL_V4_WEIGHTS: readonly number[] = [
  11950, 29600, 6667, 11950, 1200, 6666, 11950, 240, 6667, 11950, 160, 1000,
];

export const WHEEL_V4_FOLLOW: readonly (readonly number[])[] = [
  [0, 5121, 754, 1429, 129, 754, 1429, 26, 754, 1429, 17, 108], // after Diamond Plinko
  [5121, 0, 2706, 5121, 464, 2704, 5121, 90, 2706, 5121, 61, 385], // after 1x Chips
  [754, 2706, 0, 754, 69, 398, 754, 14, 398, 754, 9, 57], // after Throwables
  [1429, 5121, 754, 0, 129, 754, 1429, 26, 754, 1429, 17, 108], // after Diamond Crash
  [129, 464, 69, 129, 0, 69, 129, 2, 68, 129, 2, 10], // after Diamonds
  [754, 2704, 398, 754, 69, 0, 754, 14, 399, 754, 9, 57], // after Time Bank
  [1429, 5121, 754, 1429, 129, 754, 0, 26, 754, 1429, 17, 108], // after Donkey Cross
  [26, 90, 14, 26, 2, 14, 26, 0, 14, 26, 1, 1], // after 2x Chips
  [754, 2706, 398, 754, 68, 399, 754, 14, 0, 754, 9, 57], // after Rabbit Hunt
  [1429, 5121, 754, 1429, 129, 754, 1429, 26, 754, 0, 17, 108], // after Diamond Mines
  [17, 61, 9, 17, 2, 9, 17, 1, 9, 17, 0, 1], // after 3x Chips
  [108, 385, 57, 108, 10, 57, 108, 1, 57, 108, 1, 0], // after Upgrade
];

/** The bonus-game ords on the main wheel, in ord order: the cross-tier rule moves weight only between these. */
export const WHEEL_V4_GAME_ORDS: readonly number[] = [1, 4, 7, 10];

/** ord -> the bonus game it awards, for the four game segments. */
export const WHEEL_V4_GAME_BY_ORD: Readonly<Record<number, string>> = {
  1: 'plinko',
  4: 'crash',
  7: 'crossing',
  10: 'mines',
};

export const WHEEL_V4_UPGRADE_WEIGHTS: readonly number[] = [
  20000, 20000, 20000, 20000, 9600, 7400, 2000, 1000,
];

/** The Upgrade wheel ord that awards each Super game. */
export const WHEEL_V4_UPGRADE_ORD_BY_GAME: Readonly<Record<string, number>> = {
  plinko: 1,
  crash: 2,
  crossing: 3,
  mines: 4,
};
