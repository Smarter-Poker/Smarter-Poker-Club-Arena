import { describe, expect, it, vi } from 'vitest';
import {
  LeavePendingDiagnostic,
  LeavePendingOperation,
  leavePendingError,
  leavePendingTerminalReason,
  type LeavePendingGuardSite,
} from './LeavePendingDiagnostic.js';

describe('bounded leave-step evidence, without error or promise ownership', () => {
  it('copies errors before later reporting can mutate them', () => {
    const diagnostic = new LeavePendingDiagnostic('table', 10757147, 7);
    const attempt = diagnostic.beginAttempt(1)!;
    const error = Object.assign(new Error('supabase_timeout'), { code: '57014' });
    attempt.departures.phase('table_seats_query');
    attempt.departures.fail(error);
    attempt.rejected(error);
    attempt.retryDecision('retry_scheduled');
    error.message = '[reporter] changed';
    expect(diagnostic.snapshot()).toMatchObject({
      table_id: 'table',
      hand_number: 10757147,
      persistence_generation: 7,
      attempts: [
        {
          error: { message: 'supabase_timeout', code: '57014' },
          departures: { phase: 'table_seats_query', error: { message: 'supabase_timeout' } },
        },
      ],
    });
    const copy = diagnostic.snapshot();
    copy.attempts[0].departures.error!.message = 'modified copy';
    expect(diagnostic.snapshot().attempts[0].departures.error!.message).toBe('supabase_timeout');
  });

  it('retains returned-error detail without replacing or mutating the thrown value', () => {
    const original = Object.freeze({ message: 'supabase_timeout', code: '57014' });
    const operation = new LeavePendingOperation();
    operation.phase('move_enumeration_rpc');
    operation.fail(original, 'returned_error');
    operation.fail(new Error('translated error'));
    expect(operation.snapshot()).toMatchObject({
      status: 'rejected',
      failure_kind: 'returned_error',
      error: { message: 'supabase_timeout', code: '57014' },
    });
    expect(original).toEqual({ message: 'supabase_timeout', code: '57014' });
    expect(leavePendingError('primitive failure').message).toBe('primitive failure');
    expect(leavePendingError(null).capture_incomplete).toBe(true);
  });

  it('never invokes a diagnostic error getter or custom serialization', () => {
    const getter = vi.fn(() => {
      throw new Error('must not run');
    });
    const error = {
      get message() {
        return getter();
      },
      toJSON: getter,
    };
    expect(leavePendingError(error)).toMatchObject({ message: null, capture_incomplete: true });
    expect(getter).not.toHaveBeenCalled();
    const proxy = new Proxy({}, { getOwnPropertyDescriptor: getter });
    expect(leavePendingError(proxy).capture_incomplete).toBe(true);
  });

  it('bounds strings, attempts and retained move history with independent attempt state', () => {
    const diagnostic = new LeavePendingDiagnostic('table', 10757147, 7);
    for (let i = 1; i <= 3; i++) diagnostic.beginAttempt(i);
    expect(diagnostic.beginAttempt(4)).toBeUndefined();
    expect(diagnostic.snapshot().attempts).toHaveLength(3);
    expect(diagnostic.snapshot().attempts_truncated).toBe(true);
    expect(diagnostic.snapshot().attempts[1].departures.status).toBe('not_started');
    expect(leavePendingError('x'.repeat(600))).toMatchObject({
      message: 'x'.repeat(512),
      truncated: true,
    });
    expect(leavePendingTerminalReason('r'.repeat(200))).toMatchObject({
      reason: 'r'.repeat(128),
      truncated: true,
    });
    const operation = new LeavePendingOperation();
    for (let i = 0; i < 40; i++) {
      operation.beginMove(`move-${i}`);
      operation.rpcStart(1);
      operation.rpcFailed(new Error('lost reply'));
      operation.rpcStart(2);
      operation.rpcFinished();
    }
    expect(operation.snapshot()).toMatchObject({
      move_id: 'move-39',
      prior_recovered_move_rpc_failures: 39,
      rpc_attempts: [
        { attempt: 1, status: 'rejected' },
        { attempt: 2, status: 'fulfilled' },
      ],
    });
  });

  it('marks only the predicates actually evaluated by the selected short-circuit branch', () => {
    const diagnostic = new LeavePendingDiagnostic('table', 1, 1);
    const attempt = diagnostic.beginAttempt(1)!;
    attempt.retryDecision('budget_exhausted');
    expect(attempt.snapshot()).toMatchObject({
      transient_checked: false,
      lifecycle_checked: false,
    });
    attempt.retryDecision('non_transient');
    expect(attempt.snapshot()).toMatchObject({ transient_checked: true, lifecycle_checked: false });
    attempt.retryDecision('lifecycle_denied');
    expect(attempt.snapshot()).toMatchObject({ transient_checked: true, lifecycle_checked: true });
  });

  it('bounds a fully populated three-attempt snapshot, including JSON escape expansion', () => {
    // Fixture bound for canonical UUIDs/current fields, not a measured RPC or
    // ingestion transport limit. This source test still requires native execution.
    const uuid = '11111111-1111-4111-8111-111111111111';
    const diagnostic = new LeavePendingDiagnostic(
      uuid,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER
    );
    const error = Object.assign(new Error('\u0000'.repeat(512)), { code: '\u0000'.repeat(32) });
    const sites: LeavePendingGuardSite[] = [
      'runStep_entry',
      'read_departures_entry',
      'departure_locked_callback',
      'after_departures',
      'before_move_execution',
      'after_move_execution',
      'after_move_mirrors',
      'runStep_retry',
    ];
    for (let i = 1; i <= 3; i++) {
      const attempt = diagnostic.beginAttempt(i)!;
      for (const operation of [attempt.departures, attempt.move_read, attempt.move_execution]) {
        operation.phase('move_execution_rpc');
        operation.fail(error);
      }
      attempt.move_execution.beginMove(uuid);
      for (let rpc = 1; rpc <= 2; rpc++) {
        attempt.move_execution.rpcStart(rpc);
        attempt.move_execution.rpcFailed(error, 'returned_error');
      }
      attempt.move_execution.fail(error);
      attempt.rejected(error);
      attempt.retryDecision('lifecycle_denied');
      for (const site of sites)
        attempt.guard(site, false, {
          running: false,
          terminal: true,
          current_engine: false,
          lease_scope: 'tournament',
          lease_verified: true,
          lease_generation: uuid,
          lease_expired: true,
          proof_deadline_monotonic_ms: Number.MAX_VALUE,
          observed_monotonic_ms: Number.MAX_VALUE,
          first_terminal: leavePendingTerminalReason('\u0000'.repeat(128)),
        });
    }
    const snapshot = diagnostic.snapshot();
    expect(snapshot.attempts).toHaveLength(3);
    expect(snapshot.attempts.every((attempt) => Object.keys(attempt.guards).length === 8)).toBe(
      true
    );
    expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeLessThan(128 * 1024);
  });
});
