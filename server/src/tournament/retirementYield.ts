/**
 * A BREAK RETIREMENT THAT RAN OUT OF SWEEP BUDGET HAS YIELDED (2026-10-11).
 *
 * The retirement custody (services/TournamentRetirementCustody.ts) checks its
 * caller's `current()` at every step, and the elimination sweep's `current()`
 * includes `eliminationMutationAllowed()`. When a slow RPC spends the sweep's
 * work budget part way through a break retirement, the next check throws one of
 * the two staleness errors below. The custody keeps its reservation for the
 * same generation to replay, and the sweep's finally block requeues the work
 * because the budget expired, so this is the designed yield and not a failure.
 *
 * It is a yield ONLY when the budget really has expired. The same errors with
 * budget left mean the lease, the lifecycle or the reservation changed under
 * the retirement, and those stay reported.
 */
export const RETIREMENT_STALENESS_ERRORS: ReadonlySet<string> = new Set([
  'retirement_custody_stale',
  'admission_revision_stale',
]);

export function isBudgetYieldedRetirement(error: unknown, budgetExpired: boolean): boolean {
  if (!budgetExpired) return false;
  const message = error instanceof Error ? error.message : undefined;
  return typeof message === 'string' && RETIREMENT_STALENESS_ERRORS.has(message);
}
