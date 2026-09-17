/** A phase can consume only what remains of the case's one fixed deadline. */
export function remainingObservationMs(deadline: number, now = Date.now()): number {
  const remaining = deadline - now;
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new Error('The live-table case has no time remaining for its mandatory causal proof');
  }
  return remaining;
}
