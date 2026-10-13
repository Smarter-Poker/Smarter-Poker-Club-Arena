import { describeError } from '../services/errorReporter.js';

/**
 * WHICH POST-COMMIT RETRIES ARE WORTH A LINE (2026-10-12).
 *
 * The post-commit obligation loop retries until the envelope applies, and it
 * reported its first failure and every tenth. `smarter_private.f06_try_lane`
 * answers a contended canonical lane with F06_RETRY_CANONICAL_LANE: an explicit
 * request to run the same transaction again, raised before anything is
 * written. Measured on engine b4475501 over five hours on 2026-10-12: 106 of
 * the 133 first-attempt reports were that request, and every one of those hands
 * applied on a later attempt (no give-up alert was filed). The first attempt
 * of a requested retry is the loop doing its job, not a failure.
 *
 * Every other first failure is still reported, the tenth attempt of any cause
 * is still reported, and the give-up alert is unchanged.
 */
export function isRequestedLaneRetry(error: unknown): boolean {
  return describeError(error).includes('F06_RETRY_CANONICAL_LANE');
}

export function shouldReportPostCommitAttempt(attempt: number, error: unknown): boolean {
  if (attempt > 0 && attempt % 10 === 0) return true;
  return attempt === 1 && !isRequestedLaneRetry(error);
}
