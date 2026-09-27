import { TerminalSettlementRefusedError } from './terminalSettlementRpc.js';

/**
 * ONE FINISH ENTERS POSTGRES AT A TIME - IN THIS PROCESS TOO (2026-09-27).
 *
 * `fn_complete_tournament_terminal` opens by calling
 * `fn_ca_lock_settlement_lane_for_finish`, which for every ordinary
 * (non-satellite) tournament takes `pg_advisory_xact_lock('ca:tournament-
 * finish-lane:v1')` - a single EXCLUSIVE advisory lock with no scope: the
 * database allows exactly one tournament to finish, platform-wide, at a time.
 * Nothing on the engine side knew that. The elimination scheduler
 * (TournamentEliminationScheduler) bounds how many sweeps run at once
 * (default 4, compensated to 8 while any are stalled) but has no idea that a
 * sweep reaching `finishTournament` may make a call that can only ever have
 * ONE winner across the whole fleet - so during a burst of tournaments that
 * all become decided within the same few seconds, several sweeps happily
 * entered `fn_complete_tournament_terminal` concurrently and queued on the
 * exact same Postgres lock. Every blocked caller occupied one scheduler slot
 * for as long as the RPC's own `statement_timeout` (45s) before Postgres
 * cancelled it with "canceling statement due to statement timeout" - which
 * the engine correctly classifies as a TRANSIENT, proven refusal (`timeout`,
 * see engineInstruments.classifyFinishRefusal) and retries, by law, on a flat
 * five-second clock (aRuleRefusalStopsAskingEveryFiveSeconds pins that a
 * transient reason must NOT back off). That retry re-entered the very same
 * contended lock, alongside every other decided tournament doing the same, so
 * under sustained load the backlog did not drain - it just kept re-asking a
 * question forty-five seconds at a time.
 *
 * Measured live 2026-09-27 (~02:15-02:20 UTC): 87-114 tournaments
 * simultaneously decided-but-RUNNING and growing, every one's
 * `engine_tournament_leases` heartbeat under five seconds old (so this batch
 * was never a fenced/dead manager - see docs/changelog/2026-09-26-a-heartbeat-
 * nobody-answered-is-asked-again.md for that separate, already-fixed
 * mechanism), the `fn_ca_tournament_finished_but_not_completed` cron correctly
 * alerting on every one of them, and a live `Tournament.atomic_finish_refused`
 * alert (`refusal_reason: "timeout"`) for a tournament that is itself in the
 * stuck list - the manager IS trying, and IS losing the race for the lock.
 *
 * The database's lock is correct and is not touched here (no migration; see
 * CLAUDE.md 10.11/10.12). This module makes the ENGINE, which is the thing
 * hammering that lock with itself, model the exact same one-at-a-time rule
 * IN PROCESS: concurrent sweeps in this one Node process take a cheap,
 * in-memory turn instead of opening several live Postgres connections that
 * can only ever let one of them proceed. A caller that cannot get a turn
 * within `TERMINAL_FINISH_GATE_WAIT_MS` never touches Postgres at all and
 * throws `TerminalFinishGateTimeoutError` - a `TerminalSettlementRefusedError`
 * whose message is recognised by `classifyFinishRefusal` as `timeout`, so it
 * flows through the EXISTING, unaltered refusal/alert/retry law: one alert if
 * it is new, a flat five-second re-ask, no backoff, no fence. Nothing about
 * money changes - a caller that times out here never attempted the RPC, so
 * there is nothing to reconcile.
 *
 * This does not remove multi-instance or database-side contention (the
 * database's lock still serializes correctly across every engine process),
 * and it does not change what a genuinely slow single finish looks like. It
 * removes the self-inflicted amplifier: this one process no longer opens N
 * concurrent, 45-second-blocking connections to fight over a lock only one of
 * them can hold.
 */

export const TERMINAL_FINISH_GATE_WAIT_MS = 8_000;

/** Proven, transient, and free of side effects: nothing was ever attempted. */
export class TerminalFinishGateTimeoutError extends TerminalSettlementRefusedError {
  constructor(readonly waitedMs: number) {
    super(
      `terminal finish lane: canceling statement due to statement timeout ` +
        `(in-process gate, waited ${waitedMs}ms behind another tournament's finish and never reached Postgres)`
    );
    this.name = 'TerminalFinishGateTimeoutError';
  }
}

interface Waiter {
  grant: () => void;
  settled: boolean;
}

let locked = false;
const waiters: Waiter[] = [];

/** Test/diagnostic only: never drives a decision. */
export function terminalFinishGateSnapshot(): { locked: boolean; waiting: number } {
  return { locked, waiting: waiters.length };
}

function releaseLock(): void {
  const next = waiters.shift();
  if (next) {
    // Ownership passes directly to the next waiter; `locked` stays true.
    next.settled = true;
    next.grant();
    return;
  }
  locked = false;
}

/** Resolves immediately if free; otherwise resolves when this waiter is granted. */
function acquireLock(): { promise: Promise<void>; cancel: () => void } {
  if (!locked) {
    locked = true;
    return { promise: Promise.resolve(), cancel: () => {} };
  }
  const waiter: Waiter = { grant: () => {}, settled: false };
  const promise = new Promise<void>((resolve) => {
    waiter.grant = () => resolve();
    waiters.push(waiter);
  });
  const cancel = (): void => {
    if (waiter.settled) {
      // Granted in the same tick our own wait budget expired: we now own the
      // lock and nobody else will ever release it. Release it ourselves
      // rather than leak it - the caller who lost the race never runs `fn`.
      releaseLock();
      return;
    }
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
  };
  return { promise, cancel };
}

/**
 * Runs `fn` with exclusive process-wide access to the terminal finish lane.
 * If another call already holds it and this one cannot get a turn inside
 * `waitMs`, `fn` is NEVER invoked and a `TerminalFinishGateTimeoutError` is
 * thrown instead - see the module comment for why that is safe and how it is
 * classified.
 */
export async function runInTerminalFinishGate<T>(
  fn: () => Promise<T>,
  waitMs: number = TERMINAL_FINISH_GATE_WAIT_MS
): Promise<T> {
  const startedAt = Date.now();
  const { promise, cancel } = acquireLock();
  const timedOut = Symbol('terminal_finish_gate_timeout');
  let timer: ReturnType<typeof setTimeout> | null = null;
  const acquired = await Promise.race([
    promise.then(() => true as const),
    new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), Math.max(0, waitMs));
      timer.unref?.();
    }).then((value) => value),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  if (acquired === timedOut) {
    cancel();
    throw new TerminalFinishGateTimeoutError(Date.now() - startedAt);
  }
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}
