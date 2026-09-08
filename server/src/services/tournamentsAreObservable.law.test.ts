/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A TOURNAMENT MUST BE VISIBLE TO MONITORING (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-08-31 `/metrics` carried 895 `poker_*` series and NOT ONE mentioned
 * a tournament. Every rule file was about tables, and a tournament that never
 * started owns no table — so it was invisible by construction. Consequences,
 * all measured in the 2026-08-30/31 audit and all found by a human running SQL
 * rather than by an alarm:
 *
 *   - 10 of 16 RUNNING MTTs hung heads-up-won for hours, champion unpaid;
 *   - 19 scheduled events spawned nothing for six days;
 *   - one event paid 141% of its prize pool.
 *
 * These pins are the contract that keeps that from being true again.
 */
import { describe, expect, it, vi } from 'vitest';
// The failure is an explicit fixture even when this checkout has live credentials.
vi.mock('./supabase.js', () => ({
  supabase: {
    rpc: vi.fn(async () => ({ data: null, error: { message: 'audit fixture: unavailable' } })),
  },
}));
import { supabase } from './supabase.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  OVERDUE_START_MINUTES,
  STUCK_COMPLETING_MINUTES,
  TournamentMetrics,
  UNPAID_LOOKBACK_HOURS,
} from './TournamentMetrics.js';

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

/** Every gauge an alert rule is allowed to depend on. */
const REQUIRED_GAUGES = [
  'poker_tournaments_running',
  'poker_tournaments_registering',
  'poker_tournaments_overdue_start',
  'poker_tournaments_stuck_completing',
  'poker_tournament_seatless_phantoms',
  'poker_tournaments_unpaid_completed',
  'poker_tournament_metrics_stale_seconds',
];

describe('the engine exposes tournament gauges', () => {
  it('emits every gauge the alert rules reference', () => {
    const lines = new TournamentMetrics().toPrometheus().join('\n');
    for (const g of REQUIRED_GAUGES) {
      expect(lines, `${g} is emitted`).toContain(g);
      // A gauge without HELP/TYPE is a gauge nobody can interpret.
      expect(lines, `${g} has HELP`).toContain(`# HELP ${g}`);
      expect(lines, `${g} has TYPE`).toContain(`# TYPE ${g} gauge`);
    }
  });

  it('every emitted value is a finite number, never NaN or undefined', () => {
    for (const line of new TournamentMetrics().toPrometheus()) {
      if (line.startsWith('#')) continue;
      const value = line.split(' ').pop();
      expect(Number.isFinite(Number(value)), `"${line}" carries a number`).toBe(true);
    }
  });

  /**
   * THE ONE THAT MATTERS MOST.
   *
   * A collector that has never read the database must NOT present as a healthy
   * platform. Zeroes across the board are indistinguishable from perfect
   * health, which is the exact defect shape this codebase keeps re-learning
   * (`remainingCount || 0`, `players ?? []`, `takenRows || []`).
   */
  it('a collector that has never succeeded reports itself as stale, loudly', () => {
    const lines = new TournamentMetrics().toPrometheus().join('\n');
    const stale = Number(
      lines
        .split('\n')
        .find((l) => l.startsWith('poker_tournament_metrics_stale_seconds'))
        ?.split(' ')[1]
    );
    // Must exceed the TournamentMetricsStale rule's 600s threshold, or a boot
    // that can never read the database looks perfectly healthy forever.
    expect(stale).toBeGreaterThan(600);
  });

  it('a failed refresh keeps the last good snapshot rather than zeroing it', async () => {
    const m = new TournamentMetrics();
    // Seed a good snapshot without touching the database.
    (m as unknown as { snapshot: Record<string, number> }).snapshot = {
      running: 42,
      registering: 7,
      overdueStart: 0,
      stuckCompleting: 0,
      seatlessPhantoms: 0,
      unpaidCompleted: 0,
      seatFirstWaiting: 3,
      collectedAt: Date.now(),
    };
    // The mocked RPC refuses the read; the snapshot must survive.
    await m.refresh();
    expect(supabase.rpc).toHaveBeenCalledWith('fn_tournament_metrics', expect.any(Object));
    expect(m.get().running).toBe(42);
    expect(m.get().registering).toBe(7);
  });
});

describe('the alert rules are wired and reference only real gauges', () => {
  const rules = () => read('../../../infra/monitoring/tournament-rules.yml');

  it('the rule file is loaded by prometheus and mounted into the container', () => {
    expect(read('../../../infra/monitoring/prometheus.yml')).toContain(
      '/etc/prometheus/tournament-rules.yml'
    );
    expect(read('../../../infra/monitoring/docker-compose.yml')).toContain(
      './tournament-rules.yml:/etc/prometheus/tournament-rules.yml:ro'
    );
  });

  it('declares real rule groups - a file that alerts on nothing is worse than none', () => {
    const src = rules();
    expect(src).toContain('groups:');
    expect(src.match(/- alert: /g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it('every metric named in an expression is one the engine actually emits', () => {
    const emitted = new TournamentMetrics().toPrometheus().join('\n');
    const exprs = rules().match(/^\s*expr:\s*(.+)$/gm) ?? [];
    expect(exprs.length).toBeGreaterThanOrEqual(5);

    for (const line of exprs) {
      for (const metric of line.match(/poker_[a-z_]+/g) ?? []) {
        expect(emitted, `${metric} is emitted by the engine`).toContain(metric);
      }
    }
  });

  it('covers the four failures that actually happened, plus the blind-collector case', () => {
    const src = rules();
    for (const alert of [
      'TournamentNeverStarted',
      'TournamentStuckCompleting',
      'TournamentSeatlessPhantoms',
      'TournamentCompletedUnpaid',
      'TournamentMetricsStale',
    ]) {
      expect(src, `${alert} exists`).toContain(`alert: ${alert}`);
    }
  });

  /**
   * An alert that fires on normal behaviour gets muted, and a muted alert is
   * no alert. The seat-first count read 31 on production the day this was
   * built — all SNG/Spin with zero entrants, which is their resting state.
   */
  it('never alerts on the seat-first waiting count', () => {
    const exprLines = (rules().match(/^\s*expr:\s*(.+)$/gm) ?? []).join('\n');
    expect(exprLines).not.toContain('poker_tournaments_seat_first_waiting');
  });

  it('the collector constants the rule text quotes are all positive', () => {
    expect(OVERDUE_START_MINUTES).toBeGreaterThan(0);
    expect(STUCK_COMPLETING_MINUTES).toBeGreaterThan(0);
    expect(UNPAID_LOOKBACK_HOURS).toBeGreaterThan(0);
    // The operator-facing text names these numbers; keep them in the file.
    const src = rules();
    expect(src).toContain(`${OVERDUE_START_MINUTES}\n`.trim());
    expect(src).toContain(`${UNPAID_LOOKBACK_HOURS} hours`);
  });
});

describe('a failed tournament payout escalates as money, not just as an error', () => {
  it('an incomplete atomic finish receipt raises a critical financial alert', () => {
    const src = read('../tournament/TournamentManagerEliminations.ts');
    expect(src).toContain("from '../services/financialAlerts.js'");
    expect(src).toContain('Tournament.atomic_terminal_settlement_failed');

    // Awaited, so the alert is on disk before the process can be recycled.
    expect(src).toMatch(
      /await raiseFinancialAlert\(\s*'critical',\s*'Tournament\.atomic_terminal_settlement_failed'/
    );
  });
});
