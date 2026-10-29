import { describe, it, vi, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { WeeklyPayoutPause } from './WeeklyPayoutPause.js';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../services/supabase/client.js', () => ({ supabase: { rpc } }));
import {
  WeeklyPayoutDatabaseClock,
  createWeeklyPayoutPauseStore,
} from './weeklyPayoutPauseStore.js';
describe('database-relative payout clock and original operation readback', () => {
  it('native future reader seeds the original announcement and money timers without maintenance', async () => {
    vi.useFakeTimers();
    const expected = {
      contract: 'weekly-payout-owned-phase-v1',
      observed_at: '2026-11-02T08:00:00+00:00',
      boundary: {
        run_id: 'cae00000-0000-0000-0000-000000000003',
        ownership_token: 'cae00000-0000-0000-0000-000000000004',
        scope_kind: 'global',
        scope_id: 'cae00000-0000-0000-0000-000000000003',
        period_start: '2026-10-26T07:00:00+00:00',
        period_end: '2026-11-02T08:00:00+00:00',
        announced_at: '2026-11-02T09:58:00+00:00',
        money_starts_at: '2026-11-02T10:00:00+00:00',
        money_deadline_at: '2026-11-02T10:04:00+00:00',
        expires_at: '2026-11-02T10:05:00+00:00',
        phase: 'draining',
      },
    };
    // The native PG suite supplies its actual default RPC response here.
    // Ordinary engine tests retain the same synthetic contract independently.
    const payload = process.env.WEEKLY_PAYOUT_NATIVE_STATE
      ? JSON.parse(readFileSync(process.env.WEEKLY_PAYOUT_NATIVE_STATE, 'utf8'))
      : expected;
    expect(payload).toEqual(expected);
    vi.setSystemTime(new Date(payload.observed_at));
    rpc.mockReset();
    rpc.mockResolvedValueOnce({ data: payload, error: null });
    const store = createWeeklyPayoutPauseStore('instance-one', () => []);
    const early = await store.readCurrent();
    expect(early).not.toBeNull();
    expect(rpc).toHaveBeenCalledWith('fn_weekly_accounting_payout_pause_state', {
      p_run_id: null,
      p_ownership_token: null,
    });
    // The monotonic clock has separate jump/late-response proof below;
    // deterministic fake elapsed time drives the original operation timers.
    vi.spyOn(store.clock, 'now').mockImplementation(() => Date.now());
    const engine = {
      isRunning: () => true,
      pauseForWeeklyPayout: vi.fn(),
      engageWeeklyPayoutHandPause: vi.fn(),
      resumeFromWeeklyPayout: vi.fn(),
      isParkedForWeeklyPayout: () => false,
    };
    const control = new WeeklyPayoutPause({
      now: () => store.clock.now(),
      engines: () => [engine],
      admit: store.admit,
      read: store.read,
      onChanged: vi.fn(),
    });
    try {
      control.accept(early!);
      expect(engine.pauseForWeeklyPayout).not.toHaveBeenCalled();
      expect(engine.engageWeeklyPayoutHandPause).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(118 * 60000 - 1);
      expect(engine.pauseForWeeklyPayout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(engine.pauseForWeeklyPayout).toHaveBeenCalledTimes(1);
      expect(engine.engageWeeklyPayoutHandPause).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(120000);
      expect(engine.engageWeeklyPayoutHandPause).toHaveBeenCalledTimes(1);
    } finally {
      control.stop();
      vi.restoreAllMocks();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('uses monotonic elapsed time and survives host clock jumps and late replies', () => {
    let monotonic = 10;
    const clock = new WeeklyPayoutDatabaseClock(() => monotonic);
    expect(() => clock.now()).toThrow('clock_unread');
    clock.observe('2026-11-02T09:58:00Z');
    const start = clock.now();
    monotonic = 1010;
    expect(clock.now()).toBe(start + 1000);
    clock.observe('2026-11-02T09:58:00.100Z');
    expect(clock.now()).toBe(start + 1000);
    const fake = vi.spyOn(Date, 'now').mockReturnValue(0);
    monotonic = 2010;
    expect(clock.now()).toBe(start + 2000);
    fake.mockRestore();
  });
  it('rejects an unreadable database clock', () => {
    const clock = new WeeklyPayoutDatabaseClock(() => 1);
    expect(() => clock.observe('not-a-date')).toThrow('clock_invalid');
  });
  it('reads the exact original owner after an unknown acknowledgement without replaying money', async () => {
    rpc.mockReset();
    const store = createWeeklyPayoutPauseStore('instance-one', () => []);
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'NETWORK', message: 'response lost' } });
    const expected = {
      runId: '10000000-0000-0000-0000-000000000001',
      ownershipToken: '10000000-0000-0000-0000-000000000002',
      scopeKind: 'global' as const,
      scopeId: '10000000-0000-0000-0000-000000000003',
      periodStart: '2026-10-26T07:00:00Z',
      periodEnd: '2026-11-02T08:00:00Z',
      announcedAt: 0,
      moneyStartsAt: 120000,
      moneyDeadlineAt: 360000,
      expiresAt: 420000,
      phase: 'draining' as const,
    };
    await expect(store.admit(expected)).rejects.toThrow('admission_unknown');
    rpc.mockResolvedValueOnce({
      data: {
        contract: 'weekly-payout-owned-phase-v1',
        observed_at: '2026-11-02T09:59:00Z',
        boundary: {
          run_id: expected.runId,
          ownership_token: expected.ownershipToken,
          scope_kind: 'global',
          scope_id: expected.scopeId,
          period_start: expected.periodStart,
          period_end: expected.periodEnd,
          announced_at: '2026-11-02T09:58:00Z',
          money_starts_at: '2026-11-02T10:00:00Z',
          money_deadline_at: '2026-11-02T10:04:00Z',
          expires_at: '2026-11-02T10:05:00Z',
          phase: 'released',
        },
      },
      error: null,
    });
    expect((await store.read(expected)).phase).toBe('released');
    expect(rpc.mock.calls.map((x) => x[0])).toEqual([
      'fn_weekly_accounting_payout_pause_ack',
      'fn_weekly_accounting_payout_pause_state',
    ]);
    expect(rpc.mock.calls[1][1]).toEqual({
      p_run_id: expected.runId,
      p_ownership_token: expected.ownershipToken,
    });
  });
  it('does not turn a missing or malformed boundary into an empty healthy fleet', async () => {
    rpc.mockReset();
    rpc.mockResolvedValueOnce({ data: null, error: null });
    const store = createWeeklyPayoutPauseStore('instance-one', () => []);
    await expect(store.readCurrent()).rejects.toThrow('state_invalid');
  });
});
