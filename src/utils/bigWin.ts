/**
 * ONE BIG WIN, EVERY GAME (2026-10-01).
 *
 * Plinko gave a landing at five times the drop a celebration of its own (Dan
 * played twenty games without seeing one); Crash, Donkey Cross and Mines had no
 * such moment, so the same 5x in another game ended on an ordinary receipt.
 * The bar lives here once and the shared receipt (BonusCompletion) carries the
 * moment, so every game marks a big win the same way.
 */
export const BIG_WIN_MULTIPLE = 5;
/** The same bar as a multiplier in cents: 500 is five times the stake. */
export const BIG_WIN_CENTS = BIG_WIN_MULTIPLE * 100;

/** True when a round paid five times what it staked or more. Unknown stakes are never big. */
export function isBigPayout(
  paidChips: number | null | undefined,
  stakeChips: number | null | undefined
): boolean {
  if (!Number.isFinite(paidChips) || !Number.isFinite(stakeChips)) return false;
  const paid = Number(paidChips);
  const stake = Number(stakeChips);
  return stake > 0 && paid >= stake * BIG_WIN_MULTIPLE;
}
