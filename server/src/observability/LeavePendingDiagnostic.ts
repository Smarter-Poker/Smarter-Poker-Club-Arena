/** Leave-step evidence only: no I/O, promises, timers, retries or authority. */
export type LeavePendingPhase =
  | 'not_started'
  | 'departure_sweep'
  | 'table_seats_query'
  | 'departure_processing'
  | 'departure_locked_callback'
  | 'departure_departed_callback'
  | 'move_enumeration_rpc'
  | 'move_enumeration_validation'
  | 'move_execution_rpc'
  | 'move_receipt_validation'
  | 'move_outcome_processing'
  | 'local_teardown'
  | 'move_hold_reconciliation'
  | 'move_mirrors';
type FailureKind = 'thrown' | 'returned_error';
type Status = 'not_started' | 'pending' | 'fulfilled' | 'rejected' | 'skipped_non_cluster';
type RetryDecision = 'budget_exhausted' | 'non_transient' | 'lifecycle_denied' | 'retry_scheduled';

function now(): number | null {
  try {
    const value = Date.now();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Never stringify arbitrary errors or invoke their message/code accessors. */
export function leavePendingError(error: unknown) {
  let message: string | null = typeof error === 'string' ? error : null;
  let code: string | null = null;
  let capture_incomplete = false;
  try {
    if (error !== null && typeof error === 'object') {
      const m = Object.getOwnPropertyDescriptor(error, 'message');
      const c = Object.getOwnPropertyDescriptor(error, 'code');
      if (m && 'value' in m && typeof m.value === 'string') message = m.value;
      if (c && 'value' in c && typeof c.value === 'string') code = c.value;
      if ((m && !('value' in m)) || (c && !('value' in c))) capture_incomplete = true;
    }
  } catch {
    capture_incomplete = true;
  }
  return {
    message: message?.slice(0, 512) ?? null,
    code: code?.slice(0, 32) ?? null,
    truncated: (message?.length ?? 0) > 512 || (code?.length ?? 0) > 32,
    capture_incomplete: capture_incomplete || message === null,
  };
}

export function leavePendingTerminalReason(reason: string) {
  return {
    reason: typeof reason === 'string' ? reason.slice(0, 128) : null,
    truncated: typeof reason === 'string' && reason.length > 128,
    observed_at_ms: now(),
  };
}

export interface LeavePendingLifecycle {
  running: boolean;
  terminal: boolean;
  current_engine: boolean;
  lease_scope: 'cash' | 'tournament' | null;
  lease_verified: boolean;
  lease_generation: string | null;
  lease_expired: boolean;
  proof_deadline_monotonic_ms: number | null;
  observed_monotonic_ms: number | null;
  first_terminal: ReturnType<typeof leavePendingTerminalReason> | null;
}
export type LeavePendingGuardSite =
  | 'runStep_entry'
  | 'read_departures_entry'
  | 'departure_locked_callback'
  | 'after_departures'
  | 'before_move_execution'
  | 'after_move_execution'
  | 'after_move_mirrors'
  | 'runStep_retry';

export class LeavePendingOperation {
  private state = {
    status: 'not_started' as Status,
    phase: 'not_started' as LeavePendingPhase,
    failure_kind: null as FailureKind | null,
    error: null as ReturnType<typeof leavePendingError> | null,
    move_id: null as string | null,
    move_id_truncated: false,
    rpc_attempts: [] as Array<{
      attempt: number;
      status: 'pending' | 'fulfilled' | 'rejected';
      failure_kind: FailureKind | null;
      error: ReturnType<typeof leavePendingError> | null;
    }>,
    rpc_attempts_truncated: false,
    prior_recovered_move_rpc_failures: 0,
  };

  phase(phase: LeavePendingPhase): void {
    this.state.phase = phase;
    this.state.status = 'pending';
  }

  fail(error: unknown, kind: FailureKind = 'thrown'): void {
    // Keep the returned database error captured before existing reporters or
    // new Error(message) translate it; do not change the thrown value.
    if (this.state.status === 'rejected') return;
    this.state.status = 'rejected';
    this.state.failure_kind = kind;
    this.state.error = leavePendingError(error);
  }

  finish(): void {
    if (this.state.status !== 'skipped_non_cluster') this.state.status = 'fulfilled';
  }

  skip(): void {
    this.state.status = 'skipped_non_cluster';
  }

  beginMove(moveId: string): void {
    // Retain only the current move. Earlier recovered failures remain a count,
    // never an implied complete history or an unbounded list of candidates.
    this.state.prior_recovered_move_rpc_failures += this.state.rpc_attempts.filter(
      (entry) => entry.status === 'rejected'
    ).length;
    this.state.move_id = typeof moveId === 'string' ? moveId.slice(0, 128) : null;
    this.state.move_id_truncated = typeof moveId === 'string' && moveId.length > 128;
    this.state.rpc_attempts = [];
    this.state.rpc_attempts_truncated = false;
    this.state.error = null;
    this.state.failure_kind = null;
  }

  rpcStart(attempt: number): void {
    this.phase('move_execution_rpc');
    if (this.state.rpc_attempts.length < 2) {
      this.state.rpc_attempts.push({ attempt, status: 'pending', failure_kind: null, error: null });
    } else {
      this.state.rpc_attempts_truncated = true;
    }
  }

  rpcFailed(error: unknown, kind: FailureKind = 'thrown'): void {
    const entry = this.state.rpc_attempts[this.state.rpc_attempts.length - 1];
    if (!entry || entry.status === 'rejected' || this.state.rpc_attempts_truncated) return;
    entry.status = 'rejected';
    entry.failure_kind = kind;
    entry.error = leavePendingError(error);
  }

  rpcFinished(): void {
    const entry = this.state.rpc_attempts[this.state.rpc_attempts.length - 1];
    if (entry && !this.state.rpc_attempts_truncated) entry.status = 'fulfilled';
  }

  snapshot() {
    return {
      ...this.state,
      error: this.state.error && { ...this.state.error },
      rpc_attempts: this.state.rpc_attempts.map((entry) => ({
        ...entry,
        error: entry.error && { ...entry.error },
      })),
    };
  }
}

export class LeavePendingAttempt {
  readonly departures = new LeavePendingOperation();
  readonly move_read = new LeavePendingOperation();
  readonly move_execution = new LeavePendingOperation();
  private readonly started_at_ms = now();
  private ended_at_ms: number | null = null;
  private local_phase: LeavePendingPhase = 'not_started';
  private selected_failure: 'departures' | 'move_read' | 'move_execution' | 'local' = 'local';
  private error: ReturnType<typeof leavePendingError> | null = null;
  private decision: RetryDecision | null = null;
  private transient_checked = false;
  private lifecycle_checked = false;
  private readonly guards: Partial<
    Record<
      LeavePendingGuardSite,
      {
        allowed: boolean;
        observed_at_ms: number | null;
        state: LeavePendingLifecycle | null;
      }
    >
  > = {};

  constructor(readonly attempt: number) {}

  phase(phase: LeavePendingPhase): void {
    this.local_phase = phase;
  }
  selectFailure(branch: 'departures' | 'move_read' | 'move_execution'): void {
    this.selected_failure = branch;
  }
  guard(site: LeavePendingGuardSite, allowed: boolean, state: LeavePendingLifecycle | null): void {
    this.guards[site] = {
      allowed,
      observed_at_ms: now(),
      state: state && {
        ...state,
        first_terminal: state.first_terminal && { ...state.first_terminal },
      },
    };
  }
  rejected(error: unknown): void {
    this.error = leavePendingError(error);
    this.ended_at_ms = now();
  }
  retryDecision(decision: RetryDecision): void {
    this.decision = decision;
    this.transient_checked = decision !== 'budget_exhausted';
    this.lifecycle_checked = decision === 'lifecycle_denied' || decision === 'retry_scheduled';
  }
  snapshot() {
    const guards: typeof this.guards = {};
    for (const site of Object.keys(this.guards) as LeavePendingGuardSite[]) {
      const observation = this.guards[site];
      if (observation) {
        guards[site] = {
          ...observation,
          state: observation.state && {
            ...observation.state,
            first_terminal: observation.state.first_terminal && {
              ...observation.state.first_terminal,
            },
          },
        };
      }
    }
    return {
      attempt: this.attempt,
      started_at_ms: this.started_at_ms,
      ended_at_ms: this.ended_at_ms,
      local_phase: this.local_phase,
      selected_failure: this.selected_failure,
      error: this.error && { ...this.error },
      retry_decision: this.decision,
      transient_checked: this.transient_checked,
      lifecycle_checked: this.lifecycle_checked,
      guards,
      departures: this.departures.snapshot(),
      move_read: this.move_read.snapshot(),
      move_execution: this.move_execution.snapshot(),
    };
  }
}

export class LeavePendingDiagnostic {
  private readonly attempts: LeavePendingAttempt[] = [];
  private attempts_truncated = false;
  constructor(
    private readonly tableId: string,
    private readonly handNumber: number,
    private readonly persistenceGeneration: number
  ) {}

  beginAttempt(attempt: number): LeavePendingAttempt | undefined {
    if (this.attempts.length >= 3) {
      this.attempts_truncated = true;
      return undefined;
    }
    const entry = new LeavePendingAttempt(attempt);
    this.attempts.push(entry);
    return entry;
  }

  snapshot() {
    return {
      table_id: this.tableId,
      hand_number: this.handNumber,
      persistence_generation: this.persistenceGeneration,
      attempts_truncated: this.attempts_truncated,
      attempts: this.attempts.map((attempt) => attempt.snapshot()),
    };
  }
}
