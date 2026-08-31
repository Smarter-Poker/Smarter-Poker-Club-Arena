/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPIN METRICS — the format's central promise, on a gauge for the first time
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS. Spin charges no rake. There is no fee row, no ledger line,
 * nothing to reconcile — the 8% is ENGINEERED INTO THE MULTIPLIER DISTRIBUTION
 * and shows up only as one equality:
 *
 *     E[multiplier] = seats x (1 - rake_rate) = 3 x 0.92126 = 2.7637726
 *
 * That equality IS the product. If it drifts down the players are quietly
 * paying more than the lobby advertises; if it drifts up the house is paying
 * out of the reserve pool until the pool cannot cover a 100x. Until this file
 * existed nothing on the platform had ever checked it except a human typing
 * SQL during the 2026-08-31 audit.
 *
 * `v_spin_draw_distribution_7d` was not that check. It compares per-tier
 * counts against expectation, which is a SHAPE test: a distribution can look
 * right tier by tier and still carry a materially wrong mean, because a
 * handful of extra 100x draws move E further than a thousand extra 2x draws.
 * Only the mean tests the equality, and only a z-score tests the mean, since
 * "is it 2.7638" is unanswerable and any fixed tolerance is simultaneously too
 * tight at 22,000 draws and far too loose at 200.
 *
 * ── WHAT ELSE RIDES ALONG ────────────────────────────────────────────────
 * The same round trip carries the reveal-lag percentiles (the wheel's own
 * punctuality, measurable at all only since spin_reveal_lag_ms shipped) and
 * the depth of every spin repair queue — unpaid settlements, unattributed
 * rake, booking gaps, unfilled waits. Each of those already had a view and a
 * repair job; none of them had an alert, so a repair job that stopped running
 * would have looked exactly like a repair job with nothing to do.
 *
 * ── FAIL-CLOSED, LOUDLY (the TournamentMetrics precedent) ─────────────────
 * A failed read must never read as "zero of everything", which is
 * indistinguishable from perfect health. So a failed refresh keeps the LAST
 * GOOD snapshot, and `poker_spin_metrics_stale_seconds` always tells the truth
 * about how old that snapshot is. A broken collector is visible as a broken
 * collector, not as a healthy platform.
 *
 * ── AND A GAUGE IS NEVER FAKED ───────────────────────────────────────────
 * When no spin started in the window there is no p50, and 0 would be a LIE of
 * the worst kind here — 0ms lag is the perfect score. Those series are OMITTED
 * rather than zeroed, and `poker_spin_reveal_window_spins` says why they are
 * missing. The alert rules are written against that absence deliberately.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

export interface SpinMetricsSnapshot {
  /** Spins that STARTED inside the lag window and recorded a lag. */
  revealSpins: number;
  /** Reveal lag percentiles in ms. null = no spins in the window, NOT zero. */
  revealP50Ms: number | null;
  revealP90Ms: number | null;
  revealP99Ms: number | null;
  revealWorstMs: number | null;
  /** Spins whose reveal was already past its own 1s lead-in when it fired. */
  revealPastLeadIn: number;

  /** Draws in the 24h fairness window. */
  fairnessDraws: number;
  /** Realised mean multiplier. null when the window is empty. */
  fairnessRealisedE: number | null;
  /** The spec equality, read from spin_tier_spec rather than hardcoded. */
  fairnessSpecE: number | null;
  /** Standard errors between realised and spec. null below 2 draws. */
  fairnessZ: number | null;
  /** |z| >= 4 on >= 2000 draws. */
  fairnessDrift: boolean;
  /**
   * Draws made while the reserve pool had tiers locked out. NOT a fault — the
   * alternative is advertising a 100x the pool cannot pay — but it lowers the
   * conditional mean, so it is the discriminator between "the RNG is wrong"
   * and "the pool was thin". A drift alarm without it would send everyone to
   * the wrong explanation first.
   */
  fairnessConstrained: number;

  /** Settled rake that credited nobody, or was never measured. */
  attributionGaps: number;
  /** Spins whose prize left the reserve pool and reached no wallet. */
  unpaidSettlements: number;
  /** Spins where the pool booked a different multiplier than it paid. */
  bookingGaps: number;
  /** Spins sitting open past their fill deadline. */
  unfilledWaits: number;
  /** Clubs whose reserve pool cannot cover the top tier. */
  reserveThinClubs: number;
  /** Smallest reserve balance across clubs. null when no club has a pool. */
  reserveMinBalance: number | null;

  /** Epoch ms of the read that produced this. 0 = never succeeded. */
  collectedAt: number;
}

const EMPTY: SpinMetricsSnapshot = {
  revealSpins: 0,
  revealP50Ms: null,
  revealP90Ms: null,
  revealP99Ms: null,
  revealWorstMs: null,
  revealPastLeadIn: 0,
  fairnessDraws: 0,
  fairnessRealisedE: null,
  fairnessSpecE: null,
  fairnessZ: null,
  fairnessDrift: false,
  fairnessConstrained: 0,
  attributionGaps: 0,
  unpaidSettlements: 0,
  bookingGaps: 0,
  unfilledWaits: 0,
  reserveThinClubs: 0,
  reserveMinBalance: null,
  collectedAt: 0,
};

/** How far back the reveal-lag percentiles look. */
export const LAG_WINDOW_MINUTES = 60;

export class SpinMetrics {
  private snapshot: SpinMetricsSnapshot = { ...EMPTY };
  private refreshing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private reportedBlind = false;

  constructor(private readonly refreshMs = 60_000) {}

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get(): SpinMetricsSnapshot {
    return this.snapshot;
  }

  /** Never throws, never zeroes a good snapshot on failure. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const { data, error } = await supabase.rpc('fn_spin_metrics', {
        p_lag_window_minutes: LAG_WINDOW_MINUTES,
      });

      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row) {
        this.noteFailure(error?.message ?? 'no row returned');
        return;
      }

      /** Non-negative integer, or 0. For counts, where 0 is a truthful floor. */
      const n = (v: unknown) => {
        const x = Number(v);
        return Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;
      };
      /** A real measurement, or null. NEVER 0 — see the header. */
      const f = (v: unknown): number | null => {
        if (v === null || v === undefined) return null;
        const x = Number(v);
        return Number.isFinite(x) ? x : null;
      };

      this.snapshot = {
        revealSpins: n(row.reveal_spins),
        revealP50Ms: f(row.reveal_p50_ms),
        revealP90Ms: f(row.reveal_p90_ms),
        revealP99Ms: f(row.reveal_p99_ms),
        revealWorstMs: f(row.reveal_worst_ms),
        revealPastLeadIn: n(row.reveal_past_lead_in),
        fairnessDraws: n(row.fairness_draws),
        fairnessRealisedE: f(row.fairness_realised_e),
        fairnessSpecE: f(row.fairness_spec_e),
        fairnessZ: f(row.fairness_z),
        fairnessDrift: row.fairness_drift === true,
        fairnessConstrained: n(row.fairness_constrained),
        attributionGaps: n(row.attribution_gaps),
        unpaidSettlements: n(row.unpaid_settlements),
        bookingGaps: n(row.booking_gaps),
        unfilledWaits: n(row.unfilled_waits),
        reserveThinClubs: n(row.reserve_thin_clubs),
        reserveMinBalance: f(row.reserve_min_balance),
        collectedAt: Date.now(),
      };
      this.consecutiveFailures = 0;
      this.reportedBlind = false;
    } catch (err) {
      this.noteFailure(err instanceof Error ? err.message : String(err));
    } finally {
      this.refreshing = false;
    }
  }

  /** Reported ONCE per outage, not once per attempt. */
  private noteFailure(reason: string): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= 3 && !this.reportedBlind) {
      this.reportedBlind = true;
      reportError(
        new Error(
          `[SpinMetrics] ${this.consecutiveFailures} consecutive refresh failures (${reason}) - spin gauges are STALE. poker_spin_metrics_stale_seconds is climbing, and nothing is checking that E[multiplier] still equals the 2.7638 the format is sold on.`
        ),
        'SpinMetrics.refresh_failed'
      );
    }
  }

  /**
   * Prometheus text exposition.
   *
   * `stale_seconds` is emitted even when nothing has ever been collected — and
   * especially then, at a value that is already firing.
   */
  toPrometheus(): string[] {
    const s = this.snapshot;
    const staleSeconds =
      s.collectedAt === 0 ? 86_400 : Math.max(0, Math.round((Date.now() - s.collectedAt) / 1000));

    const out: string[] = [];
    /** Emit a gauge only when it is a real measurement. */
    const gauge = (name: string, help: string, value: number | null | undefined) => {
      if (value === null || value === undefined || !Number.isFinite(value)) return;
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
    };

    gauge(
      'poker_spin_reveal_window_spins',
      `Spins that started in the last ${LAG_WINDOW_MINUTES}m and recorded a reveal lag. When this is 0 the percentile gauges below are ABSENT, not zero - 0ms lag is the perfect score and must never be faked.`,
      s.revealSpins
    );
    gauge(
      'poker_spin_reveal_lag_p50_ms',
      'Median ms between the reveal anchor the three players were promised and the moment the engine actually fired it',
      s.revealP50Ms
    );
    gauge('poker_spin_reveal_lag_p90_ms', 'p90 reveal lag (ms)', s.revealP90Ms);
    gauge('poker_spin_reveal_lag_p99_ms', 'p99 reveal lag (ms)', s.revealP99Ms);
    gauge('poker_spin_reveal_lag_worst_ms', 'Worst reveal lag in the window (ms)', s.revealWorstMs);
    gauge(
      'poker_spin_reveal_past_lead_in',
      'Spins whose reveal fired after its own 1s lead-in had already elapsed - the wheel had to be re-anchored and the players saw it start late',
      s.revealPastLeadIn
    );

    gauge(
      'poker_spin_draw_window_draws',
      'Multipliers drawn in the 24h fairness window',
      s.fairnessDraws
    );
    gauge(
      'poker_spin_draw_expected_multiplier',
      'The spec equality E[multiplier] = seats x (1 - rake_rate), read from spin_tier_spec. Spin charges no rake; THIS is the rake.',
      s.fairnessSpecE
    );
    gauge(
      'poker_spin_draw_realised_multiplier',
      'Mean multiplier actually drawn in the window. Below spec means players paid more edge than the lobby advertises.',
      s.fairnessRealisedE
    );
    gauge(
      'poker_spin_draw_fairness_z',
      'Standard errors between the realised and spec mean. Sample-size aware, because a 0.03 gap is noise in a day and an alarm in a week.',
      s.fairnessZ
    );
    gauge(
      'poker_spin_draw_fairness_drift',
      '1 when |z| >= 4 on at least 2000 draws',
      s.fairnessDrift ? 1 : 0
    );
    gauge(
      'poker_spin_draw_constrained',
      'Draws made while the reserve pool had tiers locked out. Not a fault, but it lowers the conditional mean - check this BEFORE concluding the RNG drifted.',
      s.fairnessConstrained
    );

    gauge(
      'poker_spin_unpaid_settlements',
      'Spins whose prize left the reserve pool and reached no wallet',
      s.unpaidSettlements
    );
    gauge(
      'poker_spin_draw_booking_gaps',
      'Spins where the pool booked a different multiplier than it paid',
      s.bookingGaps
    );
    gauge(
      'poker_spin_unfilled_waits',
      'Spins sitting open past their fill deadline',
      s.unfilledWaits
    );
    gauge(
      'poker_spin_reserve_thin_clubs',
      'Clubs whose reserve pool cannot cover the top tier, so the top tiers are locked out of the draw',
      s.reserveThinClubs
    );
    gauge(
      'poker_spin_reserve_min_balance',
      'Smallest reserve pool balance across clubs',
      s.reserveMinBalance
    );
    gauge(
      'poker_rake_attribution_gaps',
      'Settled tournament rake that credited nobody, or was never measured. Every row is a player who lost VIP points and an agent who lost commission.',
      s.attributionGaps
    );

    gauge(
      'poker_spin_metrics_stale_seconds',
      'Age of the spin snapshot. A failed read keeps the last good values, so THIS is what proves the gauges above are current.',
      staleSeconds
    );

    return out;
  }
}
