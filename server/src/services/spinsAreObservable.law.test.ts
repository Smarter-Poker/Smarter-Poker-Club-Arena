/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SPIN'S CENTRAL EQUALITY MUST BE WATCHED (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Spin charges no rake. The 8% is engineered into the multiplier distribution
 * and exists only as:
 *
 *     E[multiplier] = seats x (1 - rake_rate) = 3 x 0.92126 = 2.7637726
 *
 * The first and only time that equality was ever verified in the platform's
 * life was a human typing SQL during the 2026-08-31 audit. These pins are the
 * contract that keeps it watched.
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
import { SpinMetrics, LAG_WINDOW_MINUTES, type SpinMetricsSnapshot } from './SpinMetrics.js';

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

/**
 * A collector holding a real reading. Needed because the gauges that CAN be
 * absent are absent on an empty collector — deliberately, see below.
 */
const seeded = (over: Partial<SpinMetricsSnapshot> = {}): SpinMetrics => {
  const m = new SpinMetrics();
  (m as unknown as { snapshot: SpinMetricsSnapshot }).snapshot = {
    revealSpins: 139,
    revealP50Ms: 4767,
    revealP90Ms: 9724,
    revealP99Ms: 14892,
    revealWorstMs: 27039,
    revealPastLeadIn: 130,
    fairnessDraws: 2489,
    fairnessRealisedE: 2.740056,
    fairnessSpecE: 2.763773,
    fairnessZ: -0.729,
    fairnessDrift: false,
    fairnessConstrained: 0,
    attributionGaps: 0,
    unpaidSettlements: 0,
    bookingGaps: 11,
    unbookedSpins: 0,
    secondsSinceLastStart: 12,
    openBoards: 9,
    unfilledWaits: 1,
    reserveThinClubs: 0,
    reserveMinBalance: 63885.44,
    collectedAt: Date.now(),
    ...over,
  };
  return m;
};

describe('the engine exposes spin gauges', () => {
  it('emits every gauge with HELP and TYPE', () => {
    const lines = seeded().toPrometheus().join('\n');
    for (const g of [
      'poker_spin_reveal_window_spins',
      'poker_spin_reveal_lag_p50_ms',
      'poker_spin_reveal_lag_p90_ms',
      'poker_spin_reveal_lag_p99_ms',
      'poker_spin_reveal_lag_worst_ms',
      'poker_spin_reveal_past_lead_in',
      'poker_spin_draw_window_draws',
      'poker_spin_draw_expected_multiplier',
      'poker_spin_draw_realised_multiplier',
      'poker_spin_draw_fairness_z',
      'poker_spin_draw_fairness_drift',
      'poker_spin_draw_constrained',
      'poker_spin_unpaid_settlements',
      'poker_spin_draw_booking_gaps',
      'poker_spin_unfilled_waits',
      'poker_spin_reserve_thin_clubs',
      'poker_spin_reserve_min_balance',
      'poker_rake_attribution_gaps',
      'poker_spin_metrics_stale_seconds',
    ]) {
      expect(lines, `${g} is emitted`).toContain(`${g} `);
      expect(lines, `${g} has HELP`).toContain(`# HELP ${g}`);
      expect(lines, `${g} has TYPE`).toContain(`# TYPE ${g} gauge`);
    }
  });

  it('every emitted value is a finite number, never NaN or undefined', () => {
    for (const line of seeded().toPrometheus()) {
      if (line.startsWith('#')) continue;
      const value = line.split(' ').pop();
      expect(Number.isFinite(Number(value)), `"${line}" carries a number`).toBe(true);
    }
  });

  /**
   * THE ONE THAT MATTERS MOST, PART ONE.
   *
   * 0ms of reveal lag is the PERFECT SCORE. Emitting 0 for "no spins ran"
   * would report the best possible health at the exact moment the collector
   * knows nothing — the same defect shape as `remainingCount || 0`. So an
   * unmeasured percentile is ABSENT, and the window count says why.
   */
  it('omits the lag percentiles rather than reporting a perfect zero', () => {
    const lines = seeded({
      revealSpins: 0,
      revealP50Ms: null,
      revealP90Ms: null,
      revealP99Ms: null,
      revealWorstMs: null,
    })
      .toPrometheus()
      .join('\n');
    expect(lines).not.toContain('poker_spin_reveal_lag_p50_ms');
    expect(lines).not.toContain('poker_spin_reveal_lag_p90_ms');
    // ...but the count that EXPLAINS the absence is still there, at zero.
    expect(lines).toContain('poker_spin_reveal_window_spins 0');
  });

  it('omits the realised mean rather than claiming a drawless window is fair', () => {
    const lines = seeded({ fairnessDraws: 0, fairnessRealisedE: null, fairnessZ: null })
      .toPrometheus()
      .join('\n');
    expect(lines).not.toContain('poker_spin_draw_realised_multiplier');
    expect(lines).not.toContain('poker_spin_draw_fairness_z ');
    expect(lines).toContain('poker_spin_draw_window_draws 0');
  });

  /** THE ONE THAT MATTERS MOST, PART TWO. */
  it('a collector that has never succeeded reports itself as stale, loudly', () => {
    const lines = new SpinMetrics().toPrometheus().join('\n');
    const stale = Number(
      lines
        .split('\n')
        .find((l) => l.startsWith('poker_spin_metrics_stale_seconds'))
        ?.split(' ')[1]
    );
    // Must exceed the SpinMetricsStale rule's 600s threshold, or a boot that
    // can never read the database looks perfectly healthy forever.
    expect(stale).toBeGreaterThan(600);
  });

  it('a failed refresh keeps the last good snapshot rather than zeroing it', async () => {
    const m = seeded();
    await m.refresh();
    expect(supabase.rpc).toHaveBeenCalledWith('fn_spin_metrics', expect.any(Object));
    expect(m.get().fairnessDraws).toBe(2489);
    expect(m.get().revealP50Ms).toBe(4767);
    expect(m.get().fairnessRealisedE).toBeCloseTo(2.740056, 6);
  });

  it('the drift flag is a number, not a boolean, so Prometheus can read it', () => {
    expect(seeded({ fairnessDrift: true }).toPrometheus().join('\n')).toContain(
      'poker_spin_draw_fairness_drift 1'
    );
    expect(seeded({ fairnessDrift: false }).toPrometheus().join('\n')).toContain(
      'poker_spin_draw_fairness_drift 0'
    );
  });

  it('the lag window is an hour - the same window fn_spin_metrics is asked for', () => {
    expect(LAG_WINDOW_MINUTES).toBe(60);
  });
});

describe('the spin alert rules are wired and reference only real gauges', () => {
  const rules = () => read('../../../infra/monitoring/spin-rules.yml');

  it('the rule file is loaded by prometheus and mounted into the container', () => {
    expect(read('../../../infra/monitoring/prometheus.yml')).toContain(
      '/etc/prometheus/spin-rules.yml'
    );
    expect(read('../../../infra/monitoring/docker-compose.yml')).toContain(
      './spin-rules.yml:/etc/prometheus/spin-rules.yml:ro'
    );
  });

  it('declares real rule groups - a file that alerts on nothing is worse than none', () => {
    const src = rules();
    expect(src).toContain('groups:');
    expect(src.match(/- alert: /g)?.length ?? 0).toBeGreaterThanOrEqual(10);
  });

  it('every metric named in an expression is one the engine actually emits', () => {
    const emitted = seeded().toPrometheus().join('\n');
    const exprs = rules().match(/^\s*expr:\s*(.+)$/gm) ?? [];
    expect(exprs.length).toBeGreaterThanOrEqual(10);
    for (const line of exprs) {
      for (const metric of line.match(/poker_[a-z_0-9]+/g) ?? []) {
        expect(emitted, `${metric} is emitted by the engine`).toContain(metric);
      }
    }
  });

  it('covers fairness, the blind collector, and every money queue', () => {
    const src = rules();
    for (const alert of [
      'SpinDrawFairnessDrift',
      'SpinMetricsStale',
      'SpinPrizeUnpaid',
      'SpinDrawBookingGapOpened',
      // The one SpinDrawBookingGapOpened is structurally blind to. Its SQL is
      // guarded on the booked amount being non-null, so it only ever compares
      // a BOOKED game against what it paid; a game with no reserve ledger row
      // at all is outside the count. 112 of those ran on 2026-08-31 while the
      // booking gauge read zero, because the backstop that books them was
      // timing out on every run.
      'SpinDrawNeverBooked',
      // The one that can see an empty factory. Every other alert in the file
      // measures games that exist, so all of them stayed green through the
      // four-hour outage on 2026-09-01 when no game could be created at all.
      'SpinFleetProducingNothing',
      'RakeAttributionBacklog',
      'SpinRevealChronicallyLate',
      'SpinReservePoolThin',
      'SpinUnfilledBacklog',
    ]) {
      expect(src, `${alert} exists`).toContain(`alert: ${alert}`);
    }
  });

  /**
   * The eleven historical booking gaps (2026-08-22 to 08-24, cause closed)
   * are a remediation decision, not an incident. An alert on the STANDING
   * count would fire the moment it shipped and be muted by the end of the
   * week — the exact failure the tournament seat-first gauge was scoped to
   * avoid. Only growth may alert.
   */
  it('alerts on NEW booking gaps, never on the closed historical eleven', () => {
    const src = rules();
    const expr = src
      .split('\n')
      .find((l) => l.includes('poker_spin_draw_booking_gaps') && l.includes('expr:'));
    expect(expr, 'the booking-gap rule exists').toBeTruthy();
    /* Any gap at all in the window. A threshold ABOVE zero would be the
       historical count smuggled into a rule, and it would go stale the moment
       that count moved. The gauge is bounded to 24h, so the closed eleven are
       outside it and zero is the honest floor. */
    expect(expr, 'any gap alerts').toMatch(/>\s*0\s*$/);
    expect(expr, 'no magic threshold').not.toMatch(/>\s*[1-9]/);
  });

  /**
   * The fairness alert is worse than useless if it sends whoever reads it to
   * the wrong explanation. A thin reserve pool lowers the conditional mean
   * with a perfectly healthy RNG, so the runbook text must name the
   * discriminator BEFORE anyone starts auditing the draw.
   */
  it('the fairness alert tells the reader to check the lockout count first', () => {
    const src = rules();
    const start = src.indexOf('alert: SpinDrawFairnessDrift');
    const body = src.slice(start, src.indexOf('alert: ', start + 10));
    expect(body).toContain('poker_spin_draw_constrained');
  });
});
