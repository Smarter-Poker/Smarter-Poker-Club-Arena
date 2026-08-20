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
  if (!payouts.some((p) => Number(p?.place) === place)) return 0;

  const safePool = Number.isFinite(pool) && pool > 0 ? pool : 0;
  if (safePool === 0) return 0;

  const round2 = (n: number) => Math.round(n * 100) / 100;

  // Normalise the structure to 100% before splitting. Every structure in
  // production sums to exactly 100 (verified across 10,797 tournaments), so
  // this is a no-op today; it exists so a malformed structure degrades
  // proportionally instead of over-paying the top places and starving the
  // last one. recoverStuckCompletingTournaments already did this, and folding
  // it in here is what lets that path share this single rule.
  const pctSum = payouts.reduce((sum, p) => sum + Number(p?.percentage ?? 0), 0);
  const norm = pctSum > 0 ? 100 / pctSum : 0;
  if (norm === 0) return 0;

  const pctOf = (p: { percentage?: number }) =>
    round2((safePool * Number(p?.percentage ?? 0) * norm) / 100);

  const lastPlace = payouts.reduce((m, p) => Math.max(m, Number(p?.place ?? 0)), 0);
  if (place !== lastPlace) {
    return pctOf(payouts.find((p) => Number(p?.place) === place)!);
  }

  const others = payouts
    .filter((p) => Number(p?.place) !== lastPlace)
    .reduce((sum, p) => sum + pctOf(p), 0);
  // Never exceed the pool and never go negative if a structure is malformed
  // (percentages summing past 100).
  return Math.max(0, round2(safePool - others));
}
