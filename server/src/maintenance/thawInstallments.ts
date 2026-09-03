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
  reason?: string;
  steps_this_call?: string[];
  elapsed_ms?: number;
  shifted?: Record<string, unknown>;
}

export interface ThawInstallmentOptions {
  /** Upper bound on RPC calls, complete or not. */
  maxCalls?: number;
  /** Consecutive transport failures tolerated before giving up. */
  maxConsecutiveErrors?: number;
  /** Pause between calls (ms); lets a lock-holder finish. */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface ThawInstallmentSummary {
  complete: boolean;
  calls: number;
  errors: number;
  last: ThawCallResult | null;
}

export const THAW_MAX_CALLS = 12;
export const THAW_MAX_CONSECUTIVE_ERRORS = 3;
export const THAW_PAUSE_MS = 250;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Drive fn_thaw_platform to completion. Resolves with the summary when the
 * function reports complete; rejects when the call budget or the error budget
 * is exhausted, or when the function refuses the freeze outright
 * (ok:false - e.g. an implausible frozen duration), because nothing a retry
 * can do will change that answer.
 */
export async function runThawInstallments(
  call: () => Promise<ThawCallResult>,
  opts: ThawInstallmentOptions = {}
): Promise<ThawInstallmentSummary> {
  const maxCalls = opts.maxCalls ?? THAW_MAX_CALLS;
  const maxErrors = opts.maxConsecutiveErrors ?? THAW_MAX_CONSECUTIVE_ERRORS;
  const pauseMs = opts.pauseMs ?? THAW_PAUSE_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? (() => undefined);

  let calls = 0;
  let errors = 0;
  let consecutiveErrors = 0;
  let last: ThawCallResult | null = null;

  while (calls < maxCalls) {
    calls += 1;
    try {
      last = (await call()) ?? {};
      consecutiveErrors = 0;
    } catch (err) {
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
      if (pauseMs > 0) await sleep(pauseMs);
      continue;
    }

    if (last.ok === false) {
      throw new Error(`thaw refused: ${last.reason ?? 'unknown'}`);
    }
    log(
      `[MaintenanceBreak] thaw call ${calls}: ${
        last.complete ? 'complete' : 'partial'
      } steps=${JSON.stringify(last.steps_this_call ?? [])} elapsed=${last.elapsed_ms ?? '?'}ms`
    );
    if (last.complete === true) {
      return { complete: true, calls, errors, last };
    }
    if (pauseMs > 0) await sleep(pauseMs);
  }

  throw new Error(`thaw incomplete after ${calls} call(s) (${errors} error(s))`);
}
