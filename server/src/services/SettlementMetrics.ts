/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SETTLEMENT METRICS — the alarm that was missing on 2026-09-04
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS. Between 21:30 on 2026-09-03 and 10:48 on 2026-09-04,
 * 139,153 hands failed to settle — between 25% and 44% of every hand dealt on
 * the platform, for thirteen hours — and NOTHING RAISED AN ALERT. The failure
 * was written to `ca_settlements.state = 'failed'` with a full `error_detail`
 * on every one of those rows. The database knew, 139,153 times, and had no way
 * to say it out loud.
 *
 * The cause was a BEFORE UPDATE trigger installed on `table_seats` without a
 * migration; it cancelled no-op updates, so a seat whose stack was already
 * correct reported zero rows written, and `fn_ca_settle_hand_stacks_absolute`
 * — correctly, by its own contract — refused the whole hand. The first failure
 * followed the trigger's installation by 0.65 seconds. It was found by someone
 * running a query against that table for an unrelated reason.
 *
 * ── A WINDOW, NOT A LIFETIME TOTAL ───────────────────────────────────────
 * This is the part that matters most. The lifetime failure ratio read **7.7%**
 * at a moment when the live rate was **44%**, because three days of healthy
 * history diluted it. A gauge computed the obvious way would have looked like
 * a minor background defect throughout the incident. Five minutes, always.
 *
 * ── A GAUGE IS NEVER FAKED ───────────────────────────────────────────────
 * When nothing settled in the window there is no failure rate, and 0 would be
 * a lie of the worst kind here — 0% is the perfect score, and "no hands are
 * settling at all" is the most serious thing this file can be looking at. That
 * series is OMITTED, and `poker_settlement_window_hands` says why it is
 * missing. The alert rules are written against that absence deliberately.
 *
 * ── FAIL-CLOSED, LOUDLY (the SpinMetrics precedent) ───────────────────────
 * A failed refresh keeps the LAST GOOD snapshot rather than zeroing it, and
 * `poker_settlement_metrics_stale_seconds` always tells the truth about how old
 * the reading is — already at 86_400, and firing, before the first collection.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

export interface SettlementMetricsSnapshot {
  windowMinutes: number;
  settled: number;
  failed: number;
  /** Settlements still walking their state machine — neither final nor failed. */
  stuck: number;
  /** failed / (settled + failed), or null when nothing settled in the window. */
  failureRate: number | null;
  /** The most recent failure text, with ids masked. Null when there are none. */
  topFailure: string | null;
  /** Epoch ms of the last SUCCESSFUL collection. 0 means never. */
  collectedAt: number;
}

const EMPTY: SettlementMetricsSnapshot = {
  windowMinutes: 5,
  settled: 0,
  failed: 0,
  stuck: 0,
  failureRate: null,
  topFailure: null,
  collectedAt: 0,
};

/** Five minutes. See the header — a lifetime ratio hid a 44% incident as 7.7%. */
export const SETTLEMENT_WINDOW_MINUTES = 5;

export class SettlementMetrics {
  private snapshot: SettlementMetricsSnapshot = { ...EMPTY };
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

  get(): SettlementMetricsSnapshot {
    return this.snapshot;
  }

  /** Never throws, never zeroes a good snapshot on failure. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const { data, error } = await supabase.rpc('fn_settlement_health', {
        p_window_minutes: SETTLEMENT_WINDOW_MINUTES,
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
        windowMinutes: n(row.window_minutes) || SETTLEMENT_WINDOW_MINUTES,
        settled: n(row.settled),
        failed: n(row.failed),
        stuck: n(row.stuck),
        failureRate: f(row.failure_rate),
        topFailure: typeof row.top_failure === 'string' ? row.top_failure : null,
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
          `[SettlementMetrics] ${this.consecutiveFailures} consecutive refresh failures (${reason}) - settlement gauges are STALE. poker_settlement_metrics_stale_seconds is climbing, and nothing is watching whether hands are settling at all. On 2026-09-04 that blind spot lasted thirteen hours and 139,153 hands.`
        ),
        'SettlementMetrics.refresh_failed'
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
      'poker_settlement_window_hands',
      `Hands that reached a terminal settlement state in the last ${s.windowMinutes}m. When this is 0 the failure-rate gauge is ABSENT, not zero - and 0 hands settling is itself the most serious reading this family can carry.`,
      s.settled + s.failed
    );
    gauge(
      'poker_settlement_settled',
      `Hands settled successfully in the last ${s.windowMinutes}m.`,
      s.settled
    );
    gauge(
      'poker_settlement_failed',
      `Hands whose settlement was refused whole in the last ${s.windowMinutes}m. 139,153 of these went unalerted over thirteen hours on 2026-09-04.`,
      s.failed
    );
    gauge(
      'poker_settlement_stuck',
      `Settlements still walking their state machine, neither final nor failed, in the last ${s.windowMinutes}m.`,
      s.stuck
    );
    gauge(
      'poker_settlement_failure_rate',
      `Failed / terminal over the last ${s.windowMinutes}m. A WINDOW, never a lifetime ratio: the lifetime number read 0.077 while the live rate was 0.44.`,
      s.failureRate
    );

    out.push(
      '# HELP poker_settlement_metrics_stale_seconds Age of the last successful settlement reading. 86400 until the first collection succeeds.',
      '# TYPE poker_settlement_metrics_stale_seconds gauge',
      `poker_settlement_metrics_stale_seconds ${staleSeconds}`
    );

    return out;
  }

  /** The current failure text, for logs and incident notes. Not a metric label. */
  describeTopFailure(): string | null {
    return this.snapshot.topFailure;
  }
}
