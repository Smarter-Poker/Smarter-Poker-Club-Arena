/**
 * A LAUNCH THAT CANNOT FINISH SEATING BEFORE :53 WAITS FOR THE THAW (2026-10-03).
 *
 * Every launch seat goes through the atomic seat door, which answers
 * platform_frozen from the :53 announcement (fn_entry_purchases_frozen). A
 * launch begun too close to :53 is cut in half: production 2026-10-03, MTT
 * 4735c72d began seating at 04:50:59, certified 194 seats at ~0.63 s apiece,
 * was refused at 04:53:01 and released its manager, and was restarted from the
 * half-seated board at 05:00:35. So the start gate estimates the seating time
 * from the field it is about to seat and, when that would cross the next :53,
 * holds the start; the first discovery pass after the thaw starts it, exactly
 * as it already starts an event whose clock falls inside the break.
 * Deliberately generous (0.75 s a seat plus a 20 s base): starting a few
 * minutes later is cheap, a half-made launch is not.
 */
export const LAUNCH_SEATING_BASE_MS = 20_000;
export const LAUNCH_SEATING_PER_PLAYER_MS = 750;
export function launchSeatingBudgetMs(fieldCount: number): number {
  const field = Number.isFinite(fieldCount) && fieldCount > 0 ? Math.ceil(fieldCount) : 0;
  return LAUNCH_SEATING_BASE_MS + field * LAUNCH_SEATING_PER_PLAYER_MS;
}
/** Hold the start when the estimated seating would run into the :53 announcement. */
export function launchWouldCrossLastHand(fieldCount: number, msUntilLastHand: number): boolean {
  return Number.isFinite(msUntilLastHand) && msUntilLastHand < launchSeatingBudgetMs(fieldCount);
}
