/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A RECOVERY THAT FLOODS THE DECISION PIPELINE IS NOT A RECOVERY (2026-09-27)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Deliberately import-free, for the same reason as engineStartBudget.ts and
 * tournamentResumeBudget.ts: the law is arithmetic and its test must not have
 * to half-initialise a database client or a worker thread to run.
 *
 * THE INCIDENT
 * Re-adoption of RUNNING events is already budgeted under the C20
 * additive-increase / multiplicative-decrease law (tournamentResumeBudget.ts).
 * But the only thing that could make a pass "distressed", and so halve the
 * budget, was a resume that came back WITHOUT a manager: a claim that answered
 * owned_elsewhere, a resume_failed, a throw, an unreadable board.
 *
 * That makes the budget blind to the one resource a successful adoption
 * actually spends. On 2026-09-22 at 13:24 UTC twenty-two events were
 * re-adopted and their tables began dealing. Every one of those resumes
 * SUCCEEDED, so the pass was never distressed and the budget climbed +5 per
 * pass to its ceiling - while the live horse-decision pipeline went
 * `expiredJobs` 0 -> 1,320 and `oldestQueuedAgeMs` 0 -> 9,274 ms, and horses
 * timed out in the middle of hands on the very tables the recovery had just
 * restored. Load caused failure, and the control law could not see it, so it
 * kept pushing.
 *
 * Horses are players. A table whose players cannot decide is not a recovered
 * table, so restoring hundreds of events faster than they can be played is not
 * a faster recovery - it is the same collapse the C20 law exists to prevent,
 * arriving through the one door that law was not watching.
 *
 * THE LAW
 * The pipeline's own health is a distress input to the SAME AIMD law, beside
 * the resume outcomes. Nothing else changes: retreat stays multiplicative,
 * recovery stays additive, and the floor (ENGINE_START_BUDGET_MIN) still keeps
 * the fleet converging rather than stalling.
 *
 * Two signals, because they fail at different speeds:
 *
 *   QUEUE AGE is the leading one. It rises before anything is lost and falls
 *   as soon as the pressure does, so it is what stops the next pass from
 *   making it worse.
 *
 *   EXPIRIES are the lagging one, and they are damage that already happened:
 *   an expired job is a horse that did not act on a live hand. Any new expiry
 *   since the previous pass is distress, with no threshold at all - there is
 *   no healthy rate of horses timing out mid-hand.
 *
 * WHY NOT ALSO TREAT A NOT-READY LANE AS DISTRESS. The lane needs about
 * twenty-four seconds to load its solver stores at boot, which is five
 * discovery passes, and an engine that has just started is exactly when the
 * fleet most needs adopting. Absence of a reading is not evidence of
 * congestion; it is measured as nothing here, and an unready lane that IS
 * congested announces itself through the queue age as soon as work arrives.
 */

/**
 * Queue age that means the pipeline is behind.
 *
 * Measured on production 2026-09-27 with 156 tables dealing and a healthy
 * fleet: `oldestQueuedAgeMs` 584 ms, `queueDepth` 17 against `maxInFlight` 64.
 * Measured during the 2026-09-22 13:24 flood: 9,274 ms. This threshold sits
 * above the first and well under the second, so an ordinary busy fleet never
 * halves its own budget and a flood is caught long before a decision expires.
 */
export const DECISION_QUEUE_AGE_DISTRESS_MS = 2_000;

export interface DecisionPipelineReading {
  /** Oldest job still queued, ms; null when nothing is queued. */
  oldestQueuedAgeMs: number | null;
  /** Lifetime expiries for this lane. Resets when the worker restarts. */
  expiredJobs: number;
}

export interface DecisionPipelineVerdict {
  distressed: boolean;
  /** Carried to the next pass so only NEW expiries count as distress. */
  expiredBaseline: number;
}

/**
 * Whether the live horse-decision pipeline was under pressure during this
 * pass, and the expiry baseline the next pass must compare against.
 *
 * A reading that cannot be trusted (a missing lane, a non-finite number) is
 * measured as no pressure and leaves the baseline alone: this law may slow a
 * recovery down, and it must never be the reason one stops.
 */
export function decisionPipelineDistress(
  reading: DecisionPipelineReading | null | undefined,
  previousExpiredJobs: number
): DecisionPipelineVerdict {
  const baseline =
    Number.isFinite(previousExpiredJobs) && previousExpiredJobs >= 0 ? previousExpiredJobs : 0;
  if (!reading || typeof reading !== 'object') {
    return { distressed: false, expiredBaseline: baseline };
  }

  const age = reading.oldestQueuedAgeMs;
  const queueBehind =
    typeof age === 'number' && Number.isFinite(age) && age >= DECISION_QUEUE_AGE_DISTRESS_MS;

  const expired = reading.expiredJobs;
  const expiredNow =
    typeof expired === 'number' && Number.isFinite(expired) && expired >= 0 ? expired : null;
  if (expiredNow === null) {
    return { distressed: queueBehind, expiredBaseline: baseline };
  }
  // A worker restart resets the counter. A lower number is a new lane, not a
  // repaired one: rebase on it and claim no distress from the difference.
  if (expiredNow < baseline) {
    return { distressed: queueBehind, expiredBaseline: expiredNow };
  }
  return { distressed: queueBehind || expiredNow > baseline, expiredBaseline: expiredNow };
}
