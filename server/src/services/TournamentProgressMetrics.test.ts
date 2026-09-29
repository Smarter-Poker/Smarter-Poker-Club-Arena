import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc, reportError } = vi.hoisted(() => ({ rpc: vi.fn(), reportError: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc } }));
vi.mock('./errorReporter.js', () => ({ reportError }));
import { TournamentMetrics } from './TournamentMetrics.js';

const counts = {
  running: 509,
  registering: 40,
  overdue_start: 24,
  stuck_completing: 0,
  seatless_phantoms: 0,
  unpaid_completed: 0,
  seat_first_waiting: 12,
};
const progress = { stalled_running: 84, overdue_breaks: 2, progressing_running: 9 };
function succeed(main: unknown = counts, perEvent: unknown = progress) {
  rpc.mockImplementation(async (name: string) => ({
    data: [name === 'fn_tournament_metrics' ? main : perEvent],
    error: null,
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  succeed();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('MTT monitoring reads progress for each event', () => {
  it('exposes silent MTTs and overdue breaks even when managers and cash games exist', async () => {
    const metrics = new TournamentMetrics();
    await metrics.refresh();
    const lines = metrics
      .toPrometheus({ owned: 509, isLeader: true, stillBooting: false })
      .join('\n');
    expect(lines).toContain('poker_mtt_stalled_running 84');
    expect(lines).toContain('poker_mtt_progressing_running 9');
    expect(lines).toContain('poker_mtt_overdue_breaks 2');
    expect(lines).toContain('poker_tournament_fleet_unserved 0');
    expect(rpc).toHaveBeenCalledWith('fn_tournament_progress_metrics', {
      p_stalled_minutes: 15,
      p_break_grace_minutes: 10,
    });
  });

  it.each([null, undefined, '', ' ', false, -1, 1.25, '12x', Number.MAX_VALUE])(
    'keeps the last good snapshot when a required count is %s',
    async (running) => {
      const metrics = new TournamentMetrics();
      await metrics.refresh();
      const good = metrics.get();
      vi.advanceTimersByTime(60_000);
      succeed({ ...counts, running });
      await metrics.refresh();
      expect(metrics.get()).toBe(good);
    }
  );

  it.each([null, {}, { stalled_running: 0 }, { stalled_running: false, overdue_breaks: 0 }])(
    'does not publish healthy zeros from incomplete progress evidence %j',
    async (row) => {
      const metrics = new TournamentMetrics();
      await metrics.refresh();
      const good = metrics.get();
      succeed(counts, row);
      await metrics.refresh();
      expect(metrics.get()).toBe(good);
    }
  );

  it('preserves a stale snapshot when either database read fails and reports the outage once', async () => {
    const metrics = new TournamentMetrics();
    await metrics.refresh();
    const good = metrics.get();
    rpc.mockImplementation(async (name: string) =>
      name === 'fn_tournament_metrics'
        ? { data: [counts], error: null }
        : { data: null, error: { message: 'progress read unavailable' } }
    );
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(60_000);
      await metrics.refresh();
    }
    expect(metrics.get()).toBe(good);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(metrics.toPrometheus().join('\n')).toContain(
      'poker_tournament_metrics_stale_seconds 240'
    );
  });

  it('does not invent a progressing count when the database function predates it', async () => {
    succeed(counts, { stalled_running: 84, overdue_breaks: 2 });
    const metrics = new TournamentMetrics();
    await metrics.refresh();
    expect(metrics.get().progressingRunning).toBeNull();
    const lines = metrics.toPrometheus().join('\n');
    expect(lines).toContain('poker_mtt_stalled_running 84');
    expect(lines).not.toContain('poker_mtt_progressing_running');
  });

  it.each([null, -1, 'x', 1.5])(
    'keeps the last good snapshot when progressing_running is malformed (%j)',
    async (bad) => {
      const metrics = new TournamentMetrics();
      await metrics.refresh();
      const good = metrics.get();
      succeed(counts, { ...progress, progressing_running: bad });
      await metrics.refresh();
      expect(metrics.get()).toBe(good);
    }
  );

  it('accepts integer strings and an explicit zero count', async () => {
    succeed({ ...counts, running: '0' }, { stalled_running: '0', overdue_breaks: '0' });
    const metrics = new TournamentMetrics();
    await metrics.refresh();
    expect(metrics.get().running).toBe(0);
    expect(metrics.get().collectedAt).toBe(Date.now());
  });

  it('does not publish an old refresh after the collector stops', async () => {
    const pending: Array<() => void> = [];
    rpc.mockImplementation(
      (name: string) =>
        new Promise((resolve) =>
          pending.push(() =>
            resolve({
              data: [name === 'fn_tournament_metrics' ? counts : progress],
              error: null,
            })
          )
        )
    );
    const metrics = new TournamentMetrics();
    const refresh = metrics.refresh();
    metrics.stop();
    pending.forEach((resolve) => resolve());
    await refresh;
    expect(metrics.get().collectedAt).toBe(0);
    const calls = rpc.mock.calls.length;
    await metrics.refresh();
    expect(rpc).toHaveBeenCalledTimes(calls);
  });
});
