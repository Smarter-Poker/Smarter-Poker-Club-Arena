/**
 * WHAT A CASH SESSION WAS BOUGHT IN FOR, AFTER A RELOAD (launch audit 2026-10-05).
 *
 * The Session Summary subtracts "total bought in" from the chips returned.
 * The page keeps that total in memory, and after a reload or remount it could
 * only re-seed it with the stack it found, so a player down 300 whose phone
 * slept was shown roughly break-even. The platform keeps the real figure (the
 * cash session's baseline: buy-in plus every add-on and rebuy that landed)
 * and `fn_my_cash_session_baseline` hands the player their own.
 *
 * The answer arrives a moment after it was asked for, and the player may have
 * added chips in this tab in between. Whatever this tab added since the ask
 * is not yet in an answer computed before it, so it is carried over.
 */
export function sessionBuyInTotal(input: {
  /** The server's baseline, or anything else when it could not be read. */
  serverBaseline: unknown;
  /** The page's total when the question was asked. */
  totalAtAsk: number;
  /** The page's total now. */
  totalNow: number;
}): number {
  const baseline = Number(input.serverBaseline);
  if (input.serverBaseline === null || input.serverBaseline === undefined) return input.totalNow;
  if (!Number.isFinite(baseline) || baseline <= 0) return input.totalNow;
  const addedSinceAsk = Math.max(0, input.totalNow - input.totalAtAsk);
  return Math.round((baseline + addedSinceAsk) * 100) / 100;
}
