/**
 * THE THAW RUNS IN INSTALLMENTS (Phase 4 of the engine-restart programme).
 *
 * fn_thaw_platform shifts every in-flight deadline forward by the frozen
 * duration. It is called through PostgREST as service_role, whose statement
 * timeout is 8 seconds, and one of its steps (tournaments.level_started_at,
 * ~20ms per running event through the table's UPDATE triggers) can spend that
 * whole budget on its own when the database is busy at :00. Before this the
 * thaw was one statement: it either finished inside 8s or rolled back whole,
 * and every clock kept the minutes it had lost.
 *
 * Since migration 20260902233000 the function checkpoints each completed
 * step in engine_maintenance_thaws.shifted and returns {complete: false} when
 * it ran out of its own budget. This helper is the caller's half: call again
 * until complete, tolerating a bounded number of transport errors (a call
 * that timed out committed nothing new, so retrying it is exactly right).
 *
 * Pure with respect to I/O: the RPC is injected, so the loop is unit-tested
 * against a fake that returns scripted responses.
 */

export interface ThawCallResult {
  ok?: boolean;
  complete?: boolean;
  retryable?: boolean;
  retry_after_ms?: number | string | null;
  reason?: string;
  released?: boolean;
  abandoned?: boolean;
  freeze_started_at?: string;
  credited_through_at?: string | null;
  effective_frozen_seconds?: number;
  ownership_token?: string;
  steps_this_call?: string[];
  elapsed_ms?: number;
  shifted?: Record<string, unknown>;
}

/** A semantic database refusal. Retrying the same owner/identity is unsafe. */
export class ThawRefusedError extends Error {
  readonly retryable = false;

  constructor(readonly reason: string) {
    super(`thaw refused: ${reason}`);
    this.name = 'ThawRefusedError';
  }
}

/**
 * The exact ancient row was atomically released without a broad clock shift.
 * Callers may reopen only after their independent null-row receipt agrees.
 */
export class ThawAbandonedError extends Error {
  readonly retryable = false;
  readonly released = true;

  constructor(
    readonly reason: string,
    readonly receipt: ThawCallResult
  ) {
    super(`thaw abandoned: ${reason}`);
    this.name = 'ThawAbandonedError';
  }
}

export interface ThawInstallmentOptions {
  /** Consecutive transport failures tolerated before giving up. */
  maxConsecutiveErrors?: number;
  /** Pause between calls (ms); lets a lock-holder finish. */
  pauseMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
  /** Process-lifecycle fence. No new installment/backoff begins after abort. */
  signal?: AbortSignal;
}

export interface ThawInstallmentSummary {
  complete: boolean;
  calls: number;
  errors: number;
  last: ThawCallResult | null;
}

export const THAW_MAX_CONSECUTIVE_ERRORS = 3;
export const THAW_PAUSE_MS = 250;
/** A receipt can defer work, but it cannot park one process indefinitely. */
export const THAW_RETRY_AFTER_MAX_MS = 60_000;

function retryAfterMs(receipt: ThawCallResult, fallbackMs: number): number {
  const requested = Number(receipt.retry_after_ms);
  const baseline = Math.max(0, fallbackMs);
  const candidate = Number.isFinite(requested) && requested >= 0 ? Math.ceil(requested) : baseline;
  // Preserve the caller's anti-spin floor while honoring a later database
  // release target. The upper fence keeps one sleep observable/cancellable;
  // a longer target is approached through bounded normal partial calls.
  return Math.min(THAW_RETRY_AFTER_MAX_MS, Math.max(baseline, candidate));
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('thaw_aborted'));
      return;
    }
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason ?? new Error('thaw_aborted'));
    };
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });

/**
 * Drive fn_thaw_platform to completion. Resolves with the summary when the
 * function reports complete; rejects when the call budget or the error budget
 * is exhausted, or when the function refuses the freeze outright
 * (ok:false - e.g. an implausible frozen duration), because nothing a retry
 * can do will change that answer.
 */
export async function runThawInstallments(
  call: (signal?: AbortSignal) => Promise<ThawCallResult>,
  opts: ThawInstallmentOptions = {}
): Promise<ThawInstallmentSummary> {
  const maxErrors = opts.maxConsecutiveErrors ?? THAW_MAX_CONSECUTIVE_ERRORS;
  const pauseMs = opts.pauseMs ?? THAW_PAUSE_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? (() => undefined);
  const signal = opts.signal;

  let calls = 0;
  let errors = 0;
  let consecutiveErrors = 0;
  let last: ThawCallResult | null = null;

  // Successful checkpoint calls are expected normal progress. The number is
  // data-dependent (notably level_started_at batches of 40), so a fixed call
  // ceiling would turn a healthy fleet above 480 targets into a false thaw
  // failure. Lifecycle abort owns the total operation; only consecutive
  // transport failures consume the bounded error budget.
  while (true) {
    signal?.throwIfAborted();
    calls += 1;
    try {
      last = (await call(signal)) ?? {};
      signal?.throwIfAborted();
      consecutiveErrors = 0;
    } catch (err) {
      signal?.throwIfAborted();
      errors += 1;
      consecutiveErrors += 1;
      log(
        `[MaintenanceBreak] thaw call ${calls} failed (${consecutiveErrors}/${maxErrors}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      if (consecutiveErrors >= maxErrors) {
        throw new Error(
          `thaw abandoned after ${errors} error(s) in ${calls} call(s): ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      if (pauseMs > 0) await sleep(pauseMs, signal);
      continue;
    }

    if (last.abandoned === true) {
      if (last.released !== true || last.complete !== true) {
        throw new ThawRefusedError('invalid_abandonment_receipt');
      }
      throw new ThawAbandonedError(last.reason ?? 'unknown', last);
    }
    if (
      last.complete !== true &&
      (last.retryable === false || (last.ok === false && last.retryable !== true))
    ) {
      throw new ThawRefusedError(last.reason ?? 'unknown');
    }
    log(
      `[MaintenanceBreak] thaw call ${calls}: ${
        last.complete ? 'complete' : 'partial'
      } steps=${JSON.stringify(last.steps_this_call ?? [])} elapsed=${last.elapsed_ms ?? '?'}ms`
    );
    if (last.complete === true) {
      if (last.ok === false) {
        throw new ThawRefusedError(last.reason ?? 'complete_but_not_ok');
      }
      if (last.released !== true) {
        throw new ThawRefusedError('complete_without_atomic_release');
      }
      return { complete: true, calls, errors, last };
    }
    // A retryable semantic receipt is prepared work, not an RPC failure. Keep
    // both error counters at zero and honor the database's release target.
    // Clamp the hint so malformed/hostile values can neither hot-spin nor
    // strand one process forever; the lifecycle signal owns the wait.
    const nextPauseMs = last.retryable === true ? retryAfterMs(last, pauseMs) : pauseMs;
    if (nextPauseMs > 0) await sleep(nextPauseMs, signal);
  }
}
