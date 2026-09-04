/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CRON FLEET METRICS — the group called cron-health that had no rules in it
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-04). `infra/monitoring/alert-rules.yml` carried a
 * group named `cron-health` containing NO RULES. A heading that alerts on
 * nothing and reads exactly like coverage.
 *
 * On the afternoon it was found, the fleet it was supposed to be watching had:
 *
 *   - FOUR Open Claw jobs stale, the worst SILENT FOR 18.3 DAYS;
 *   - TWELVE pg_cron jobs failing together at 17:46 with "job startup timeout",
 *     among them sp_prune_hand_state_snapshots_2m, daily-missions-outbox-minute
 *     and ca-auto-reconcile-tick.
 *
 * `v_openclaw_job_staleness` already existed and already computed `is_stale`.
 * Nothing had ever read it.
 *
 * ── SILENCE IS THE OBSERVABLE ────────────────────────────────────────────
 * The World Hub's own CLAUDE.md records why: when CRON_SECRET was rotated
 * without updating the Hetzner VM, all 85 Open Claw jobs returned 401 and
 * nothing noticed, because a 401 is refused before anything records it — "the
 * log does not fill with errors, it STOPS". A failure-rate gauge cannot see
 * that. Silence can, so silence is measured here alongside failures.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT MEASURE ──────────────────────────────
 * "Jobs that have never run." `cron.job` records no creation time, so a NULL
 * last_run means either "dead" or "not yet due" and nothing can tell them
 * apart — seven jobs read NULL today and five are simply younger than their
 * first window. A gauge that pages every time somebody schedules something is
 * how you get 1,345 unread alerts, which is the state the money-alert table
 * was found in on the same day.
 *
 * ── FAIL-CLOSED (the SpinMetrics precedent) ──────────────────────────────
 * A failed refresh keeps the LAST GOOD snapshot. Zero failures and zero stale
 * jobs are both the perfect score; reporting them because the collector is
 * blind is the lie this whole family of files exists to prevent.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

export interface CronFleetSnapshot {
  pgCronJobs: number;
  pgCronActive: number;
  pgCronRuns: number;
  pgCronFailures: number;
  openclawJobs: number;
  openclawStale: number;
  /** Longest silence across the Open Claw fleet, in minutes. Null when unknown. */
  openclawWorstSilenceMinutes: number | null;
  collectedAt: number;
}

const EMPTY: CronFleetSnapshot = {
  pgCronJobs: 0,
  pgCronActive: 0,
  pgCronRuns: 0,
  pgCronFailures: 0,
  openclawJobs: 0,
  openclawStale: 0,
  openclawWorstSilenceMinutes: null,
  collectedAt: 0,
};

/** Failures are counted over this window. */
export const CRON_WINDOW_MINUTES = 60;

export class CronFleetMetrics {
  private snapshot: CronFleetSnapshot = { ...EMPTY };
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

  get(): CronFleetSnapshot {
    return this.snapshot;
  }

  /** Never throws, never zeroes a good snapshot on failure. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const { data, error } = await supabase.rpc('fn_cron_fleet_health', {
        p_window_minutes: CRON_WINDOW_MINUTES,
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

      const jobs = n(row.pg_cron_jobs);
      // 125 pg_cron jobs were live when this was written. A sudden zero is a
      // blind collector, not an idle platform, and must not be published as a
      // healthy reading.
      if (jobs === 0) {
        this.noteFailure('fn_cron_fleet_health reported zero pg_cron jobs');
        return;
      }

      this.snapshot = {
        pgCronJobs: jobs,
        pgCronActive: n(row.pg_cron_active),
        pgCronRuns: n(row.pg_cron_runs),
        pgCronFailures: n(row.pg_cron_failures),
        openclawJobs: n(row.openclaw_jobs),
        openclawStale: n(row.openclaw_stale),
        openclawWorstSilenceMinutes: f(row.openclaw_worst_silence_minutes),
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
          `[CronFleetMetrics] ${this.consecutiveFailures} consecutive refresh failures (${reason}) - cron fleet gauges are STALE. Nothing is watching whether the scheduled work is running, and the last time that was true an Open Claw job went silent for eighteen days.`
        ),
        'CronFleetMetrics.refresh_failed'
      );
    }
  }

  toPrometheus(): string[] {
    const s = this.snapshot;
    const staleSeconds =
      s.collectedAt === 0 ? 86_400 : Math.max(0, Math.round((Date.now() - s.collectedAt) / 1000));

    const out: string[] = [];
    // Before the first successful collection there is no reading, and every
    // fleet number here would be 0 - which reads as "125 jobs became 0" and
    // "13 failures became none". Publish nothing but the staleness until we
    // have actually looked. Same reason a null lag is an absent series.
    const haveReading = s.collectedAt !== 0;
    const gauge = (name: string, help: string, value: number | null | undefined) => {
      if (!haveReading) return;
      if (value === null || value === undefined || !Number.isFinite(value)) return;
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
    };

    gauge(
      'poker_cron_pg_jobs',
      'pg_cron jobs defined. 0 means the collector is blind, not that the platform is idle - this database runs 125.',
      s.pgCronJobs
    );
    gauge('poker_cron_pg_jobs_active', 'pg_cron jobs with active = true.', s.pgCronActive);
    gauge(
      'poker_cron_pg_runs',
      `pg_cron runs started in the last ${CRON_WINDOW_MINUTES}m.`,
      s.pgCronRuns
    );
    gauge(
      'poker_cron_pg_failures',
      `pg_cron runs in the last ${CRON_WINDOW_MINUTES}m that did not succeed. Twelve failed together at 17:46 on 2026-09-04 with "job startup timeout" and nothing reported it.`,
      s.pgCronFailures
    );
    gauge(
      'poker_cron_openclaw_jobs',
      'Open Claw jobs known to v_openclaw_job_staleness.',
      s.openclawJobs
    );
    gauge(
      'poker_cron_openclaw_stale',
      'Open Claw jobs past their own staleness threshold. Four were stale on 2026-09-04 and the view had been computing that for eighteen days with nothing reading it.',
      s.openclawStale
    );
    gauge(
      'poker_cron_openclaw_worst_silence_minutes',
      'Longest silence across the Open Claw fleet, in minutes. Silence is the only observable when a job is refused before it can log - a rotated CRON_SECRET 401s every job and the log STOPS rather than filling with errors.',
      s.openclawWorstSilenceMinutes
    );

    out.push(
      '# HELP poker_cron_metrics_stale_seconds Age of the last successful cron-fleet reading. 86400 until the first collection succeeds.',
      '# TYPE poker_cron_metrics_stale_seconds gauge',
      `poker_cron_metrics_stale_seconds ${staleSeconds}`
    );

    return out;
  }
}
