/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: THE FLEET REPORTS WHAT IT CANNOT FINISH (2026-09-17)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Read off production 2026-09-17 20:20 UTC, by hand, with SQL:
 *
 *     835 RUNNING tournaments, 547 decided for over ten minutes, the oldest
 *     for nine days; 547 horses seated in them; 560 blocked by an entry fee
 *     with no accounting batch; 864 refused finishes in an hour of engine
 *     log; 1,393 deadlocks in fourteen minutes earlier that afternoon.
 *
 * `/metrics` said `poker_tournaments_running 835` and nothing else about any
 * of it. These pins are the series that would have said it, and the three
 * ways they must refuse to lie: a failed read keeps the last good snapshot,
 * staleness is always published, and a refusal reason is a bounded label,
 * never the message.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc, reportError } = vi.hoisted(() => ({ rpc: vi.fn(), reportError: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc } }));
vi.mock('./errorReporter.js', () => ({ reportError }));

import { HorseFleetMetrics, DECIDED_MINUTES } from './HorseFleetMetrics.js';
import {
  classifyFinishRefusal,
  FINISH_REFUSAL_REASONS,
} from '../observability/engineInstruments.js';

const PRODUCTION_ROW = {
  running: 835,
  decided: 547,
  decided_over_minutes: 547,
  oldest_decided_minutes: 13417,
  horses_seated: 2403,
  horses_in_decided: 547,
  unbatched_fee_running: 560,
  lane_g_waiters: 3,
  lane_f_waiters: 7,
  lane_b_waiters: 0,
  lane_waiters_oldest_ms: 5368,
  deadlocks_total: 1841,
};

const gauge = (lines: string[], name: string): number => {
  const line = lines.find((l) => l.startsWith(`${name} `));
  if (!line) throw new Error(`${name} is not exported at all`);
  return Number(line.slice(name.length + 1));
};

function succeed(row: unknown = PRODUCTION_ROW) {
  rpc.mockImplementation(async () => ({ data: [row], error: null }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  succeed();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the fleet reports what it cannot finish', () => {
  it('asks the database once, with the decided window, and publishes every number', async () => {
    const metrics = new HorseFleetMetrics();
    await metrics.refresh();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('fn_ca_horse_fleet_metrics', {
      p_decided_minutes: DECIDED_MINUTES,
    });
    const lines = metrics.toPrometheus();
    expect(gauge(lines, 'poker_tournaments_decided_unfinished')).toBe(547);
    expect(gauge(lines, 'poker_tournaments_decided_unfinished_oldest_minutes')).toBe(13417);
    expect(gauge(lines, 'poker_horses_in_decided_games')).toBe(547);
    expect(gauge(lines, 'poker_horses_seated_in_database')).toBe(2403);
    expect(gauge(lines, 'poker_tournaments_unbatched_fee_running')).toBe(560);
    expect(gauge(lines, 'poker_settlement_lane_waiters{lane="G"}')).toBe(3);
    expect(gauge(lines, 'poker_settlement_lane_waiters{lane="F"}')).toBe(7);
    expect(gauge(lines, 'poker_settlement_lane_waiters{lane="B"}')).toBe(0);
    expect(gauge(lines, 'poker_settlement_lane_waiters_oldest_ms')).toBe(5368);
    expect(gauge(lines, 'poker_db_deadlocks_total')).toBe(1841);
    expect(gauge(lines, 'poker_horse_fleet_metrics_stale_seconds')).toBe(0);
    // A counter is a counter to Prometheus, or rate() refuses it.
    expect(lines).toContain('# TYPE poker_db_deadlocks_total counter');
  });

  it('a collector that has never read reports a day of staleness, not a row of zeroes', () => {
    const lines = new HorseFleetMetrics().toPrometheus();
    expect(gauge(lines, 'poker_horse_fleet_metrics_stale_seconds')).toBe(86_400);
    expect(gauge(lines, 'poker_tournaments_decided_unfinished')).toBe(0);
  });

  it('a failed read keeps the last good snapshot and lets staleness climb', async () => {
    const metrics = new HorseFleetMetrics();
    await metrics.refresh();
    rpc.mockImplementation(async () => ({ data: null, error: { message: 'timeout' } }));
    vi.advanceTimersByTime(7 * 60_000);
    await metrics.refresh();
    const lines = metrics.toPrometheus();
    expect(gauge(lines, 'poker_tournaments_decided_unfinished')).toBe(547);
    expect(gauge(lines, 'poker_horse_fleet_metrics_stale_seconds')).toBe(420);
  });

  it('a malformed count is a failed read, not a zero', async () => {
    const metrics = new HorseFleetMetrics();
    await metrics.refresh();
    succeed({ ...PRODUCTION_ROW, horses_in_decided: 'many' });
    await metrics.refresh();
    expect(gauge(metrics.toPrometheus(), 'poker_horses_in_decided_games')).toBe(547);
  });

  it('reports the outage once, on the third consecutive failure', async () => {
    const metrics = new HorseFleetMetrics();
    rpc.mockImplementation(async () => ({ data: null, error: { message: 'down' } }));
    for (let i = 0; i < 5; i++) await metrics.refresh();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(String(reportError.mock.calls[0][0])).toContain('3 consecutive refresh failures');
  });

  it('a stopped collector publishes nothing new', async () => {
    const metrics = new HorseFleetMetrics();
    metrics.start();
    metrics.stop();
    rpc.mockClear();
    await metrics.refresh();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('a refusal reason is a bounded label, never the message', () => {
  it('classifies what production said on 2026-09-17', () => {
    expect(
      classifyFinishRefusal(
        'tournament 309c9bde-c38c-4420-894d-2beeddeb2052 rake attribution incomplete: tournament_fee_sources_require_reconciliation'
      )
    ).toBe('fee_reconciliation');
    expect(classifyFinishRefusal('deadlock detected')).toBe('deadlock');
    expect(classifyFinishRefusal('canceling statement due to statement timeout')).toBe('timeout');
    expect(classifyFinishRefusal('atomic completion will refuse an incomplete prize set')).toBe(
      'prize_set'
    );
    expect(classifyFinishRefusal('tournament x rake attribution incomplete: other')).toBe(
      'rake_attribution'
    );
    expect(classifyFinishRefusal('something nobody has seen')).toBe('other');
    expect(classifyFinishRefusal(undefined)).toBe('other');
  });

  it('never returns a label outside the declared set', () => {
    const messages = [
      'tournament_fee_not_captured_by_original_producer',
      'accounting_terms_not_observed',
      'lock timeout',
      '',
      'x'.repeat(10_000),
    ];
    for (const m of messages) {
      expect(FINISH_REFUSAL_REASONS).toContain(classifyFinishRefusal(m));
    }
  });
});
