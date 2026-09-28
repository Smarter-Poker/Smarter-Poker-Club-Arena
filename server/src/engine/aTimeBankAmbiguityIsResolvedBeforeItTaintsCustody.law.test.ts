/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AN AMBIGUOUS TIME-BANK DEBIT IS RESOLVED BEFORE IT TAINTS CUSTODY FOREVER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Production, 2026-09-28, tournament 87a68e55-2c91-43e6-a803-4a9a2b9505b0
 * ("$100 Freeroll - 6:00 AM"), table 9333d016-f241-4f31-95ad-b3f062055f22.
 * `fn_consume_time_bank`'s RPC for that table came back
 * `Error: supabase_timeout` - an ordinary transient DB hiccup - and
 * `onTimeBankAccounting` set `this.timeBankAccountingUnconfirmed = true`
 * with nothing anywhere that ever set it back. That flag alone makes
 * `hasUnretiredStoppedTimeBankCustody()` refuse forever, which made the
 * table's stop() fail "retained time-bank custody" on every one of 80+
 * retries over 80+ minutes, quarantined the table's tournament manager
 * (`GameServer.quarantined_tournament_manager_stop_retry`,
 * `mixed:originals_not_drained:engine_stops_not_all_fulfilled`), stalled the
 * tournament's 43 other tables behind it, and held the hourly maintenance
 * certificate shut (`unparkedReasons.stopped_bank_custody_unreadable`).
 *
 * `supabase/migrations/20260928144831_time_bank_consume_is_idempotent_by_request_id.sql`
 * gives the RPC an idempotency receipt keyed on `p_request_id`, so a retry
 * with the same id can never double-deduct. This pins the engine side: an
 * ambiguous first answer is asked again ONCE, with the SAME request_id,
 * before the flag is set - "I could not tell" resolved by asking again, not
 * believed forever (CLAUDE.md 10.86). Only when the resolving retry is ALSO
 * ambiguous does the prior, permanent, fail-closed behaviour still apply -
 * the certificate is still right to refuse a genuinely unresolved custody
 * (tests/a-stopped-bank-that-can-never-be-released-does-not-hold-the-restart-shut.law.test.ts).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';
import { TimeBankEngine } from './TimeBankEngine.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';
import { supabase } from '../services/supabase.js';

const TABLE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

afterEach(() => {
  vi.restoreAllMocks();
});

function engineWithDbBackedUse() {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.timeBankEngine.configure(TABLE, { secondsPerUse: 20 });
  // 20 seconds already spent, none of it inside the free session base, none
  // of it already reported to the DB - so onTimeBankAccounting owes exactly
  // the 20 seconds every test in this file asserts on.
  engine.timeBankEngine.initializePlayer(TABLE, 'u1', { remainingSeconds: 0, usesRemaining: 0 });
  engine.timeBankMeta.set('u1', { initialSeconds: 20, baseSeconds: 0, dbConsumedSeconds: 0 });
  return engine;
}

async function triggerConsume(engine: any) {
  engine.onTimeBankAccounting({ type: 'TIME_BANK_STOPPED', tableId: TABLE, playerId: 'u1' });
  // Drain the accounting chain the same way the manager's stop() does.
  await Promise.all(engine.timeBankAccountingPending);
}

describe('a transient timeout resolves instead of tainting forever', () => {
  it('the exact production shape: supabase_timeout once, success on the resolving retry', async () => {
    const engine = engineWithDbBackedUse();
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockRejectedValueOnce(new Error('supabase_timeout'))
      .mockResolvedValueOnce({ data: { success: true, shortfall_seconds: 0 }, error: null } as any);

    await triggerConsume(engine);

    const calls = rpc.mock.calls.filter((c: unknown[]) => c[0] === 'fn_consume_time_bank');
    expect(calls).toHaveLength(2);
    // THE SAME request_id both times - the retry is a safe replay, not a
    // second, independent deduction.
    const [firstArgs, secondArgs] = calls.map((c: unknown[]) => c[1] as Record<string, unknown>);
    expect(firstArgs.p_request_id).toEqual(secondArgs.p_request_id);
    expect(typeof firstArgs.p_request_id).toBe('string');
    expect(firstArgs.p_user_id).toBe('u1');
    expect(firstArgs.p_seconds).toBe(20);

    // THE WHOLE POINT: resolved, not tainted. hasUnretiredStoppedTimeBankCustody()
    // reads exactly this flag (among others) and this is what let 9333d016's
    // stop() fail forever.
    expect(engine.timeBankAccountingUnconfirmed).toBe(false);
    expect(engine.timeBankAccountingPending.size).toBe(0);
  });

  it('an unconfirmed data.success !== true is retried once, same request_id, then resolved', async () => {
    const engine = engineWithDbBackedUse();
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValueOnce({
        data: { success: false, error: 'missing receipt' },
        error: null,
      } as any)
      .mockResolvedValueOnce({ data: { success: true, shortfall_seconds: 0 }, error: null } as any);

    await triggerConsume(engine);

    const calls = rpc.mock.calls.filter((c: unknown[]) => c[0] === 'fn_consume_time_bank');
    expect(calls).toHaveLength(2);
    expect(calls[0][1].p_request_id).toEqual(calls[1][1].p_request_id);
    expect(engine.timeBankAccountingUnconfirmed).toBe(false);
  });

  it('genuinely persistent failure still taints, exactly once retried - the certificate must still refuse', async () => {
    const engine = engineWithDbBackedUse();
    const rpc = vi.spyOn(supabase, 'rpc').mockRejectedValue(new Error('supabase_timeout'));

    await triggerConsume(engine);

    const calls = rpc.mock.calls.filter((c: unknown[]) => c[0] === 'fn_consume_time_bank');
    // ONE retry, not a loop (CLAUDE.md 10.12): exactly two attempts total.
    expect(calls).toHaveLength(2);
    expect(calls[0][1].p_request_id).toEqual(calls[1][1].p_request_id);
    // A genuinely unresolvable debit is still, correctly, fail-closed.
    expect(engine.timeBankAccountingUnconfirmed).toBe(true);
  });

  it('every consume call carries a request_id, so a replay can never double-deduct', async () => {
    const engine = engineWithDbBackedUse();
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValue({ data: { success: true, shortfall_seconds: 0 }, error: null } as any);

    await triggerConsume(engine);

    const [, args] = rpc.mock.calls.find((c: unknown[]) => c[0] === 'fn_consume_time_bank') as [
      string,
      Record<string, unknown>,
    ];
    expect(typeof args.p_request_id).toBe('string');
    expect(args.p_request_id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
