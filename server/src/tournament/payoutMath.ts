/**
 * Tournament payout arithmetic.
 *
 * Deliberately a standalone module with NO imports. Both payout sites live in
 * TournamentManagerEliminations and the stuck-COMPLETING rescue lives in
 * tournamentRecovery, and TournamentManagerBase already imports
 * tournamentRecovery -- so hosting this in the eliminations module made the
 * import graph circular (recovery -> eliminations -> base -> recovery). ESM
 * hoisting would have saved it at runtime, but a cycle around money code is
 * not worth relying on. Keeping the arithmetic dependency-free removes it.
 */
/**
 * The single rule for turning a prize pool + payout structure into one place's
 * prize. Both payout sites use it (eliminatePlayer for places 2..N,
 * finishTournament for place 1) so they can never disagree.
 *
 * PAYOUT-INTEGRITY 2026-08-20: every place used to be rounded independently,
 * so the rounded places need not add up to the pool. The 9-place structure on
 * a 483.00 pool rounds to 483.01 -- a one-cent overpay on every such event;
 * across the distinct (pool, structure) pairs actually used in production 8 of
 * 67 are off by a cent. It also put the engine permanently at odds with
 * fn_tournament_payout_reconcile, which would have reported a false "overpaid"
 * on each one and raised a critical alert.
 *
 * Rule: every place except the last is its own rounded percentage; the LAST
 * paid place takes whatever remains, so the places sum to the pool to the
 * cent. The adjustment lands on the smallest prize, never a headline one.
 * fn_tournament_payout_reconcile implements the identical rule.
 */
export function computePlacePrize(
  pool: number,
  payouts: Array<{ place?: number; percentage?: number }>,
  place: number
): number {
  if (!Array.isArray(payouts) || payouts.length === 0) return 0;
  if (!Number.isFinite(place)) return 0;

  // PAYOUT-INTEGRITY 2026-08-25: sanitise the structure BEFORE any arithmetic
  // reads it. Three malformations were reachable and each one broke the
  // "places sum to the pool" rule in the OVERPAYING direction:
  //
  //   * a non-numeric `place` (null, "2nd", undefined) made `lastPlace` NaN
  //     via Math.max, and `place !== NaN` is true for every place — so the
  //     residual branch below became unreachable and EVERY place, including
  //     the last, was paid its own rounded percentage. That is exactly the
  //     independently-rounded scheme the residual rule replaced.
  //   * a DUPLICATE place entry was counted once by `find` (the payment) but
  //     twice by the `others` sum (the residual), silently shrinking the last
  //     paid place by a whole extra share.
  //   * a NEGATIVE percentage produced a negative prize for that place while
  //     inflating the residual, and only the last place was clamped at 0.
  //
  // Normalising first and clamping every share is what makes the invariant
  // hold for any input, not just for the structures we happen to ship.
  const entries: Array<{ place: number; percentage: number }> = [];
  const seen = new Set<number>();
  for (const p of payouts) {
    const pl = Number(p?.place);
    if (!Number.isInteger(pl) || pl <= 0) continue;
    if (seen.has(pl)) continue; // first entry for a place wins, exactly as `find` did
    seen.add(pl);
    const pct = Number(p?.percentage ?? 0);
    entries.push({ place: pl, percentage: Number.isFinite(pct) && pct > 0 ? pct : 0 });
  }
  if (entries.length === 0) return 0;
  if (!entries.some((p) => p.place === place)) return 0;

  const safePool = Number.isFinite(pool) && pool > 0 ? pool : 0;
  if (safePool === 0) return 0;

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  EXACT TO THE CENT — NO BINARY FLOATS TOUCH THE MONEY (2026-08-29)
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Dan, 2026-08-29, binding: "THIS NEEDS TO BE EXACT AND 100% ACCURATE AT
   * ALL TIMES, THERE CAN NEVER BE 'ROUNDING' IT MUST ALWAYS BE DOWN TO THE
   * CENT. THERE CAN NEVER EVER EVER BE MISTAKES WHEN PAYING OUT."
   *
   * This used to compute in DOLLARS, and a dollar amount with two decimals is
   * not a number a binary float can hold. The 2026-08-20 residual rule above
   * made the places sum to the pool, but the individual places were still
   * decided by float arithmetic, and that is not the same thing as being
   * right.
   *
   * WHAT IT COST, live and repeatedly. Union Morning Classic, pool 513.00,
   * place 8 at 3.5%:
   *
   *     513 * 3.5 / 100            -> 17.955          (looks exact)
   *     (513 * 3.5 / 100) * 100    -> 1795.4999999999998
   *     Math.round(...) / 100      -> 17.95           (rounded DOWN)
   *
   * Postgres numeric is exact decimal, so fn_tournament_payout_reconcile
   * computed round(17.955, 2) = 17.96 and declared place 8 underpaid by a
   * cent. It then TOPPED IT UP -- and because place 9 absorbs the residual,
   * the event had already paid out the full 513.00. The top-up made it
   * 513.01. The checker created the overpayment it was reporting, on every
   * single run of that event, twice a day.
   *
   * The fix is not a smaller epsilon. It is to stop using floats for money:
   * everything below is integer arithmetic on CENTS and BASIS POINTS, so
   * there is no representation error to round away. `poolCents * bp` is an
   * exact integer well inside 2^53 for any pool this platform will ever hold
   * (a $10,000,000 pool at 100% is 1e13), and the single division at the end
   * is the only place a fraction appears -- deliberately, because that is the
   * one place a half-cent is legitimately decided.
   *
   * Math.round breaks a .5 tie upward and Postgres numeric round() breaks it
   * away from zero; prizes are never negative, so the two agree by
   * construction rather than by luck.
   *
   * Normalising to 100% is unchanged in meaning: every structure in
   * production sums to exactly 100 (verified across 10,797 tournaments), so
   * dividing by the structure's own total is a no-op today and degrades a
   * malformed structure proportionally instead of over-paying the top places
   * and starving the last one.
   */
  const poolCents = Math.round(safePool * 100);
  if (poolCents <= 0) return 0;

  /** A percentage as an integer number of basis points. 3.5% -> 350. */
  const bp = (pct: number) => Math.round(pct * 100);

  const totalBp = entries.reduce((sum, p) => sum + bp(p.percentage), 0);
  if (totalBp <= 0) return 0;

  /**
   * THE WHOLE LADDER IS BUILT AT ONCE, then the caller's place is read out of
   * it. Pricing one place in isolation is what made the pool escapable: the
   * last place absorbed `pool - others`, and when `others` already exceeded
   * the pool the result was clamped to 0 -- so the places summed to MORE than
   * the pool and nothing noticed.
   *
   * That is not hypothetical arithmetic pedantry: it is any pool smaller than
   * the number of places it is trying to pay, which a short-field or
   * fractional-pool event can produce. Spending the pool down as we go makes
   * over-spending impossible rather than unlikely.
   *
   * Deterministic and independent of the place asked for, so two callers
   * pricing two different places always agree.
   */
  const ordered = [...entries].sort((a, b) => a.place - b.place);
  let remaining = poolCents;
  const centsByPlace = new Map<number, number>();

  for (let i = 0; i < ordered.length; i++) {
    const isLast = i === ordered.length - 1;
    // The last paid place takes whatever is left, so the places sum to the
    // pool to the cent by construction rather than by hoping the rounding
    // cancels. Everyone else takes their share, but never more than is left.
    const share = isLast
      ? remaining
      : Math.min(remaining, Math.round((poolCents * bp(ordered[i].percentage)) / totalBp));
    const cents = Math.max(0, share);
    centsByPlace.set(ordered[i].place, cents);
    remaining -= cents;
  }

  return (centsByPlace.get(place) ?? 0) / 100;
}

/**
 * The part of a cash prize pool available to the paid-place ladder.
 *
 * Bubble protection is funded by the tournament pool. When the final field
 * extends beyond the deepest paid place, exactly one base buy-in is reserved
 * for that stone-bubble finisher before any place percentage is applied. The
 * entry fee is never part of the refund. Satellites must pass `false`; their
 * separate authority awards the sub-seat remainder to its bubble instead.
 */
export function prizePoolAvailableToPlaces(
  pool: number,
  payouts: Array<{ place?: number; percentage?: number }>,
  fieldSize: number,
  bubbleProtection: boolean,
  buyInAmount: number
): number | null {
  if (!Number.isFinite(pool) || pool < 0) return null;
  const poolCents = Math.round(pool * 100);
  if (Math.abs(pool * 100 - poolCents) > 1e-7) return null;
  if (!bubbleProtection) return poolCents / 100;

  let deepestPaidPlace = 0;
  for (const payout of payouts) {
    const place = Number(payout?.place);
    if (Number.isInteger(place) && place > deepestPaidPlace) deepestPaidPlace = place;
  }
  const finalField = Number(fieldSize);
  if (deepestPaidPlace < 1 || !Number.isInteger(finalField) || finalField < 1) return null;
  if (finalField <= deepestPaidPlace) return poolCents / 100;

  if (!Number.isFinite(buyInAmount) || buyInAmount <= 0) return null;
  const buyInCents = Math.round(buyInAmount * 100);
  if (Math.abs(buyInAmount * 100 - buyInCents) > 1e-7 || buyInCents > poolCents) return null;
  return (poolCents - buyInCents) / 100;
}
