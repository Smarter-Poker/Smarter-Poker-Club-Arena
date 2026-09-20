/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DECISION DEADLINE IS THE TURN CLOCK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A horse decision job used to expire after a fixed 8,000 ms of queue-plus-
 * compute time (`LiveHorseDecisionWorkerClient.DEFAULT_JOB_TIMEOUT_MS`),
 * whatever the table's action clock was. When the job expires the seat takes
 * the legal check or fold without thinking - `poker_horse_decision_fallbacks_total`
 * - and on a 15 s clock that fold lands with seven seconds of the turn, and a
 * whole time bank, still unused.
 *
 * Measured on engine-01, 2026-09-17, 16:20-16:50 UTC, with the main event loop
 * at 200-500 ms p50: 23.5 fallbacks a minute, 27,548 expired decisions since
 * the 14:55 boot, while the worker itself computed in 12 ms. The decisions
 * were not slow; the queue in front of a saturated main loop was, and the 8 s
 * caller deadline gave up on them with most of the clock left.
 *
 * So the deadline is now derived from the turn: what is left of the action
 * clock at the moment the job is enqueued, minus the margin the engine needs
 * to apply the answer and still act inside the clock. It is never shorter
 * than the old default's floor for a short clock (a decision that cannot get
 * two seconds is a fallback either way), and never longer than the clock
 * itself: a horse never waits for a decision past the moment its clock would
 * have folded it anyway.
 *
 * The worker-integrity window (the separate execution deadline armed at
 * dispatch, which fails a wedged worker) is NOT this number and does not move.
 */

/** Below this the job is not worth queueing; the old default's practical floor. */
export const HORSE_DECISION_MIN_DEADLINE_MS = 2_000;

/**
 * What the engine keeps back from the clock: the minimum think time (250 ms),
 * the commit round trip, and the same cushion the think-time cap already
 * reserves (`actionTimeMs - 1200`). A decision that arrives with less than
 * this left cannot be acted on before the clock folds the seat.
 */
export const HORSE_DECISION_DEADLINE_MARGIN_MS = 1_500;

/**
 * The longest a job may live even on a generous clock. Bounds the FIFO's
 * memory of a stalled table and keeps a pathological action clock (a 120 s
 * private table, say) from parking a request for two minutes.
 */
export const HORSE_DECISION_MAX_DEADLINE_MS = 30_000;

export interface HorseDecisionDeadlineInput {
  /** The table's action clock, `tables.action_time_seconds` (engine default 15). */
  actionTimeSeconds: number | null | undefined;
  /** Milliseconds already spent on this turn when the job is enqueued. */
  elapsedMs: number;
}

/**
 * The caller deadline for one decision job, in milliseconds from enqueue.
 *
 * Pure. `actionTimeSeconds` that is missing, non-finite or non-positive reads
 * as the engine's 15 s default, exactly as `forceArmTurnTimer` treats it.
 * Negative or non-finite `elapsedMs` reads as zero; a turn cannot have
 * negative age.
 */
export function horseDecisionDeadlineMs(input: HorseDecisionDeadlineInput): number {
  const seconds =
    typeof input.actionTimeSeconds === 'number' &&
    Number.isFinite(input.actionTimeSeconds) &&
    input.actionTimeSeconds > 0
      ? input.actionTimeSeconds
      : 15;
  const elapsed =
    typeof input.elapsedMs === 'number' && Number.isFinite(input.elapsedMs) && input.elapsedMs > 0
      ? input.elapsedMs
      : 0;
  const remaining = seconds * 1000 - elapsed - HORSE_DECISION_DEADLINE_MARGIN_MS;
  return Math.round(
    Math.min(HORSE_DECISION_MAX_DEADLINE_MS, Math.max(HORSE_DECISION_MIN_DEADLINE_MS, remaining))
  );
}
