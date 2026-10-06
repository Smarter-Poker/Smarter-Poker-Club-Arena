/**
 * A SEAT JUST TAKEN IS NOT A BUST (launch audit 2026-10-05).
 *
 * The bust-rebuy prompt opens when the hero's seat shows a zero stack and no
 * hand is in progress. In the first seconds after a buy-in those two facts
 * can be true of a seat that is fully funded: the seat is known before the
 * table's own snapshot has reported its stack. Production, 2026-10-04: a
 * player bought in for 1,000.00 at 19:40:05 and was charged a second
 * 1,000.00 "rebuy" at 19:40:11, holding a full stack; 990.00 came back later.
 *
 * A bust is a fall to zero. So inside the settling window after THIS tab took
 * the seat (the same fifteen seconds the page already treats as unsettled for
 * a fresh seat), a zero that has never been preceded by chips is not offered
 * a rebuy. Once chips have been seen for that seat, or the window has passed,
 * or the seat was not taken in this tab (a reload onto a real bust), the
 * prompt behaves exactly as before.
 */
export const FRESH_SEAT_SETTLE_MS = 15_000;

export function bustPromptMustWait(input: {
  /** When this tab took the seat, or null if it did not (reload, restore). */
  seatAcquiredAtMs: number | null;
  /** Whether a positive stack has been seen for that same seat taking. */
  chipsSeenSinceSeat: boolean;
  nowMs: number;
}): number {
  if (input.seatAcquiredAtMs === null || input.chipsSeenSinceSeat) return 0;
  const age = input.nowMs - input.seatAcquiredAtMs;
  if (!Number.isFinite(age) || age < 0) return 0;
  return Math.max(0, FRESH_SEAT_SETTLE_MS - age);
}
