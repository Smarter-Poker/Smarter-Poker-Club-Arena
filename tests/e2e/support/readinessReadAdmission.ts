import { SelectionObservationDeadline } from './selectionDeadline';

/** The existing public-health request ceiling, preserved by readiness admission. */
export const READINESS_HEALTH_READ_MS = 15_000;

/**
 * Never start a readiness read that cannot receive its existing full transport
 * budget. The poll's fixed deadline is not extended, and a late callback is not
 * a successful operational read or evidence of a production transport failure.
 */
export function readinessReadCanStart(deadline: number, now = Date.now()): boolean {
  return (
    Number.isFinite(deadline) && Number.isFinite(now) && deadline - now >= READINESS_HEALTH_READ_MS
  );
}
/** Each read in a multi-read observation must fit, not just its first request. */
export function readinessReadTimeout(deadline = Infinity, now = Date.now()): number {
  if (deadline !== Infinity && !readinessReadCanStart(deadline, now))
    throw new SelectionObservationDeadline(null);
  return READINESS_HEALTH_READ_MS;
}
