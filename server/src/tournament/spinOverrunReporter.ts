/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ONE OVERRUN IS NEWS. THIRTEEN HUNDRED IS NOISE.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `Tournament.spin_reveal_window_overrun` fires when the engine reaches the
 * draw after the wheel's own start time has already passed, so the anchor has
 * to be moved to now and the three players see the spin begin late.
 *
 * It fired ONCE PER SPIN. Production runs ~2,500 spins a day and 88-97% of
 * them overran, so this single call site produced well over a thousand error
 * reports a day — all of them true, all of them the same fact, and together
 * loud enough to bury anything else in the same stream. An alert everybody
 * has learned to scroll past is worse than no alert, because it also costs
 * the attention of whoever is reading around it.
 *
 * The fix is not to lower the volume of the truth. It is to say it once, with
 * the number attached. `poker_spin_reveal_lag_p50_ms` and
 * `poker_spin_reveal_past_lead_in` (services/SpinMetrics.ts) now carry the
 * per-spin detail continuously and at full resolution, which is the right
 * home for it; the error report's remaining job is to be the thing that fires
 * when nobody is scraping metrics at all.
 *
 * ── WHY THE FIRST ONE STILL REPORTS IMMEDIATELY ──────────────────────────
 * A pure every-N-minutes flush would open every incident with N minutes of
 * silence. So the first overrun after a quiet window reports at once, and the
 * suppression only starts after that — the shape that makes a new outage
 * loud and an ongoing one quiet, rather than the reverse.
 *
 * Pure: no clock, no IO, no engine types. The caller supplies `now`.
 */

/** How long overruns are aggregated before the next report is allowed out. */
export const OVERRUN_FLUSH_INTERVAL_MS = 10 * 60 * 1000;

export interface OverrunReport {
  /** Overruns observed since the last report, INCLUDING this one. */
  count: number;
  /** Worst lag in ms across that group. */
  worstMs: number;
  /** Ms covered by this group. 0 for an immediate first report. */
  windowMs: number;
  /** True when this is the opening report of a new incident. */
  first: boolean;
}

/**
 * Accumulates overruns and decides when one is worth reporting.
 *
 * Deliberately NOT a singleton: the engine holds one instance, and every test
 * gets its own, so the suppression state can never leak between them.
 */
export class SpinOverrunReporter {
  private pending = 0;
  private worstMs = 0;
  private lastReportAt = 0;
  private groupStartedAt = 0;

  constructor(private readonly flushIntervalMs = OVERRUN_FLUSH_INTERVAL_MS) {}

  /**
   * Record an overrun. Returns the report to emit, or null to stay quiet.
   *
   * A non-finite or negative lag is recorded as 0 rather than dropped: the
   * overrun HAPPENED, and losing the count because the duration was
   * unreadable would be the same class of error this file exists to avoid.
   */
  record(lagMs: number, now: number): OverrunReport | null {
    const lag = Number.isFinite(lagMs) && lagMs > 0 ? lagMs : 0;
    if (this.pending === 0) this.groupStartedAt = now;
    this.pending += 1;
    this.worstMs = Math.max(this.worstMs, lag);

    const first = this.lastReportAt === 0 || now - this.lastReportAt >= this.flushIntervalMs;
    if (!first) return null;

    const report: OverrunReport = {
      count: this.pending,
      worstMs: this.worstMs,
      windowMs: this.lastReportAt === 0 ? 0 : Math.max(0, now - this.groupStartedAt),
      first: this.lastReportAt === 0,
    };
    this.lastReportAt = now;
    this.pending = 0;
    this.worstMs = 0;
    this.groupStartedAt = now;
    return report;
  }

  /** Overruns seen but not yet reported. For tests and diagnostics. */
  get suppressed(): number {
    return this.pending;
  }
}

/** Human-readable body for a report. Separated so a test can assert on it. */
export function describeOverrun(r: OverrunReport): string {
  if (r.count === 1) {
    return `Spin start overran its own reveal window by ${r.worstMs}ms - the wheel was re-anchored to now so it plays in full, and the three players saw it start late`;
  }
  const over = r.windowMs > 0 ? ` in the last ${Math.round(r.windowMs / 1000)}s` : '';
  return `${r.count} spin starts overran their own reveal window${over} (worst ${r.worstMs}ms) - each wheel was re-anchored to now so it plays in full, and those players saw it start late. Per-spin detail is on poker_spin_reveal_lag_p50_ms and poker_spin_reveal_past_lead_in.`;
}
