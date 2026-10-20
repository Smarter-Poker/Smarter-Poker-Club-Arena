/**
 * LAUNCH LATENESS (2026-10-19). tournaments.started_at equals start_time, so a
 * late launch was invisible; the first dealt hand is the measurement. These
 * pins keep the gauges honest: unknown is absent, never a healthy zero, and a
 * failed lateness read never freezes the established tournament snapshot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc, reportError } = vi.hoisted(() => ({ rpc: vi.fn(), reportError: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc } }));
vi.mock('./errorReporter.js', () => ({ reportError }));
import {
  LATE_START_HEADROOM_SECONDS,
  LATE_START_SECONDS,
  LATE_START_WINDOW_MINUTES,
  TournamentMetrics,
} from './TournamentMetrics.js';

const counts = {
  running: 14,
  registering: 278,
  overdue_start: 0,
  stuck_completing: 0,
  seatless_phantoms: 0,
  unpaid_completed: 0,
  seat_first_waiting: 3,
};
const progress = { stalled_running: 0, overdue_breaks: 0, progressing_running: 14 };
const lateness = { late_first_hands: 2, late_waiting: 1, worst_late_seconds: 473 };

function answer(late: unknown = lateness, lateError: { message: string } | null = null) {
  rpc.mockImplementation(async (name: string) => {
    if (name === 'fn_tournament_metrics') return { data: [counts], error: null };
    if (name === 'fn_tournament_progress_metrics') return { data: [progress], error: null };
    if (name === 'fn_tournament_launch_lateness_metrics')
      return { data: lateError ? null : [late], error: lateError };
    throw new Error(`unexpected rpc ${name}`);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  answer();
});
afterEach(() => vi.useRealTimers());

const sample = (lines: string, name: string) =>
  lines.split('\n').find((l) => l.startsWith(`${name} `));

describe('MTT launch lateness is measured from the first dealt hand', () => {
  it('asks the database with the thresholds the rule text quotes', async () => {
    await new TournamentMetrics().refresh();
    expect(rpc).toHaveBeenCalledWith('fn_tournament_launch_lateness_metrics', {
      p_late_seconds: 120,
      p_headroom_seconds: 120,
      p_window_minutes: 15,
    });
    expect(LATE_START_SECONDS).toBe(120);
    expect(LATE_START_HEADROOM_SECONDS).toBe(120);
    expect(LATE_START_WINDOW_MINUTES).toBe(15);
  });

  it('publishes the counts once the database has answered', async () => {
    const m = new TournamentMetrics();
    await m.refresh();
    const lines = m.toPrometheus().join('\n');
    expect(sample(lines, 'poker_mtt_late_first_hands')).toBe('poker_mtt_late_first_hands 2');
    expect(sample(lines, 'poker_mtt_late_start_waiting')).toBe('poker_mtt_late_start_waiting 1');
    expect(sample(lines, 'poker_mtt_worst_late_start_seconds')).toBe(
      'poker_mtt_worst_late_start_seconds 473'
    );
    expect(sample(lines, 'poker_mtt_launch_lateness_stale_seconds')).toBe(
      'poker_mtt_launch_lateness_stale_seconds 0'
    );
  });

  it('never answers zero before it knows: no samples, loud staleness', () => {
    const lines = new TournamentMetrics().toPrometheus().join('\n');
    expect(sample(lines, 'poker_mtt_late_first_hands')).toBeUndefined();
    expect(sample(lines, 'poker_mtt_late_start_waiting')).toBeUndefined();
    expect(lines).toContain('# TYPE poker_mtt_late_first_hands gauge');
    expect(sample(lines, 'poker_mtt_launch_lateness_stale_seconds')).toBe(
      'poker_mtt_launch_lateness_stale_seconds 86400'
    );
  });

  it.each([
    null,
    {},
    { late_first_hands: 1, late_waiting: 0 },
    { late_first_hands: -1, late_waiting: 0, worst_late_seconds: 0 },
    { late_first_hands: '1x', late_waiting: 0, worst_late_seconds: 0 },
    { late_first_hands: 1.5, late_waiting: 0, worst_late_seconds: 0 },
  ])('keeps the last good lateness read when the row is %j', async (bad) => {
    const m = new TournamentMetrics();
    await m.refresh();
    const good = m.getLaunchLateness();
    vi.advanceTimersByTime(120_000);
    answer(bad);
    await m.refresh();
    expect(m.getLaunchLateness()).toBe(good);
    expect(sample(m.toPrometheus().join('\n'), 'poker_mtt_launch_lateness_stale_seconds')).toBe(
      'poker_mtt_launch_lateness_stale_seconds 120'
    );
  });

  it('a missing lateness function does not freeze the established tournament gauges', async () => {
    answer(lateness, { message: 'function fn_tournament_launch_lateness_metrics does not exist' });
    const m = new TournamentMetrics();
    await m.refresh();
    expect(m.get().collectedAt).toBeGreaterThan(0);
    expect(m.get().running).toBe(14);
    expect(m.getLaunchLateness().collectedAt).toBe(0);
    expect(reportError).not.toHaveBeenCalled();
    const lines = m.toPrometheus().join('\n');
    expect(sample(lines, 'poker_tournament_metrics_stale_seconds')).toBe(
      'poker_tournament_metrics_stale_seconds 0'
    );
    expect(sample(lines, 'poker_mtt_late_first_hands')).toBeUndefined();
  });

  it('a rejected lateness call is unknown, not on time', async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === 'fn_tournament_metrics') return { data: [counts], error: null };
      if (name === 'fn_tournament_progress_metrics') return { data: [progress], error: null };
      throw new Error('network');
    });
    const m = new TournamentMetrics();
    await m.refresh();
    expect(m.get().collectedAt).toBeGreaterThan(0);
    expect(m.getLaunchLateness().collectedAt).toBe(0);
  });

  it('accepts integer strings and explicit zeros', async () => {
    answer({ late_first_hands: '0', late_waiting: 0, worst_late_seconds: '0' });
    const m = new TournamentMetrics();
    await m.refresh();
    expect(m.getLaunchLateness()).toMatchObject({
      lateFirstHands: 0,
      lateWaiting: 0,
      worstLateSeconds: 0,
    });
  });
});
