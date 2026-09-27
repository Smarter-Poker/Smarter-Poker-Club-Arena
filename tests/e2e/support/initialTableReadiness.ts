/** One initial navigation budget, including rendering after the wire is ready. */
export function remainingInitialTableReadinessMs(
  startedAt: number,
  budgetMs: number,
  now = Date.now()
): number {
  const remaining = startedAt + budgetMs - now;
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(budgetMs) ||
    !Number.isFinite(now) ||
    budgetMs <= 0 ||
    now < startedAt ||
    remaining <= 0
  ) {
    throw new Error('Initial table readiness exceeded its navigation deadline');
  }
  return remaining;
}
