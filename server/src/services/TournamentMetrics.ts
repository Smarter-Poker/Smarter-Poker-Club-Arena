/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT METRICS — the numbers no alert rule could reference before
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS. `/metrics` carried 895 `poker_*` series on 2026-08-31 and
 * NOT ONE of them mentioned a tournament. The monitoring stack is real and
 * well-wired — freeze detection, supervisor alerts, a CI guard that blocks a
 * merge if the Prometheus config drifts — but tournaments were never given a
 * dimension in it. So there was no rule for "a tournament never started",
 * because there was no series to write one against.
 *
 * The cost of that was measured, not theorised. Every tournament defect found
 * in the 2026-08-30/31 audit was found by a human typing SQL:
 *
 *   - 10 of 16 RUNNING MTTs hung heads-up-won, blinds past level 100, for
 *     HOURS, with the champion unpaid;
 *   - 19 scheduled events silently spawned NOTHING for six days because a
 *     blind preset name did not resolve;
 *   - one event paid 141% of its prize pool.
 *
 * None of them fired an alarm, because none of them could.
 *
 * ── WHY THE ENGINE AND NOT A SQL EXPORTER ─────────────────────────────────
 * The most valuable signal here is "a tournament that should be running is
 * not", and an engine reporting only on tournaments it OWNS can never see it:
 * the failure IS the absence of a manager. So these come from the database,
 * which is the only place that knows what should exist.
 *
 * ── FAIL-CLOSED, LOUDLY ───────────────────────────────────────────────────
 * A failed read must never read as "zero of everything", which is
 * indistinguishable from perfect health and is the exact shape of defect this
 * codebase has documented repeatedly (`remainingCount || 0`, `players ?? []`,
 * `takenRows || []`). So:
 *
 *   - a failed refresh keeps the LAST GOOD snapshot rather than zeroing it;
 *   - `poker_tournament_metrics_stale_seconds` always tells the truth about
 *     how old that snapshot is, and is itself alertable. A broken collector is
 *     therefore visible as a broken collector, not as a healthy platform.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

export interface TournamentMetricsSnapshot {
  running: number;
  registering: number;
  /**
   * MTTs still REGISTERING/ANNOUNCED past their start time — nobody started them.
   *
   * MTT ONLY, and that scoping is the whole value of the gauge. The first cut
   * counted every format and read 31 on production, all of them SNG or SPIN
   * with ZERO entrants — which is not a fault but the ordinary resting state of
   * a seat-first game that begins when its seats fill. An alert on that number
   * would have fired the day it shipped and been muted by the end of the week.
   * An MTT starts on a clock, so an overdue MTT is a real broken promise.
   */
  overdueStart: number;
  /** SNG/Spin sitting open past a nominal start time. Information, NOT an alert. */
  seatFirstWaiting: number;
  /** Sat in COMPLETING long enough that the recovery watchdog should have finished it. */
  stuckCompleting: number;
  /** RUNNING entrants holding chips with no open seat anywhere in the event. */
  seatlessPhantoms: number;
  /** Recently COMPLETED events with a prize pool and not one prize payment. */
  unpaidCompleted: number;
  /** Epoch ms of the read that produced this. 0 = never succeeded. */
  collectedAt: number;
}

const EMPTY: TournamentMetricsSnapshot = {
  running: 0,
  registering: 0,
  overdueStart: 0,
  stuckCompleting: 0,
  seatlessPhantoms: 0,
  unpaidCompleted: 0,
  seatFirstWaiting: 0,
  collectedAt: 0,
};

/** How long a tournament may sit past its start time before it is overdue. */
export const OVERDUE_START_MINUTES = 10;
/** How long COMPLETING is tolerated before it counts as stuck. */
export const STUCK_COMPLETING_MINUTES = 10;
/** How far back the unpaid-prize check looks. */
export const UNPAID_LOOKBACK_HOURS = 6;

export class TournamentMetrics {
  private snapshot: TournamentMetricsSnapshot = { ...EMPTY };
  private refreshing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Consecutive failed refreshes, for a single escalation rather than a flood. */
  private consecutiveFailures = 0;
  private reportedBlind = false;

  constructor(private readonly refreshMs = 60_000) {}

  start(): void {
    if (this.timer) return;
    // Refresh once immediately so the first scrape after a boot is not blind
    // for a whole interval, then on the interval.
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    // Never hold the process open for a metrics timer.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get(): TournamentMetricsSnapshot {
    return this.snapshot;
  }

  /**
   * Read the counts. Never throws, never zeroes a good snapshot on failure.
   *
   * One RPC (`fn_tournament_metrics`) so the whole thing is a single round trip
   * and a single plan. A missing function is treated as any other read failure:
   * the snapshot goes stale and says so.
   */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const { data, error } = await supabase.rpc('fn_tournament_metrics', {
        p_overdue_minutes: OVERDUE_START_MINUTES,
        p_completing_minutes: STUCK_COMPLETING_MINUTES,
        p_unpaid_hours: UNPAID_LOOKBACK_HOURS,
      });

      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row) {
        this.noteFailure(error?.message ?? 'no row returned');
        return;
      }

      const n = (v: unknown) => {
        const x = Number(v);
        return Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;
      };

      this.snapshot = {
        running: n(row.running),
        registering: n(row.registering),
        overdueStart: n(row.overdue_start),
        stuckCompleting: n(row.stuck_completing),
        seatlessPhantoms: n(row.seatless_phantoms),
        unpaidCompleted: n(row.unpaid_completed),
        seatFirstWaiting: n(row.seat_first_waiting),
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

  /**
   * A failed refresh is reported ONCE per outage, not once per attempt — an
   * every-minute timer would otherwise turn one broken query into 1,440 error
   * reports a day and bury everything else.
   */
  private noteFailure(reason: string): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= 3 && !this.reportedBlind) {
      this.reportedBlind = true;
      reportError(
        new Error(
          `[TournamentMetrics] ${this.consecutiveFailures} consecutive refresh failures (${reason}) - tournament gauges are STALE. poker_tournament_metrics_stale_seconds is climbing and every tournament alert is now blind.`
        ),
        'TournamentMetrics.refresh_failed'
      );
    }
  }

  /**
   * Prometheus text exposition for the snapshot.
   *
   * `stale_seconds` is emitted even when nothing has ever been collected — and
   * especially then. A collector that has never succeeded reports a very large
   * staleness, which is a firing alert, rather than a tidy row of zeroes.
   */
  toPrometheus(): string[] {
    const s = this.snapshot;
    const staleSeconds =
      s.collectedAt === 0 ? 86_400 : Math.max(0, Math.round((Date.now() - s.collectedAt) / 1000));

    return [
      '# HELP poker_tournaments_running Tournaments the database says are RUNNING',
      '# TYPE poker_tournaments_running gauge',
      `poker_tournaments_running ${s.running}`,
      '# HELP poker_tournaments_registering Tournaments open for registration',
      '# TYPE poker_tournaments_registering gauge',
      `poker_tournaments_registering ${s.registering}`,
      `# HELP poker_tournaments_overdue_start MTTs whose start time passed over ${OVERDUE_START_MINUTES}m ago and which nobody started. MTT only: a seat-first SNG/Spin waiting for seats is not overdue.`,
      '# TYPE poker_tournaments_overdue_start gauge',
      `poker_tournaments_overdue_start ${s.overdueStart}`,
      `# HELP poker_tournaments_stuck_completing Tournaments in COMPLETING for over ${STUCK_COMPLETING_MINUTES}m - the recovery watchdog should have settled them`,
      '# TYPE poker_tournaments_stuck_completing gauge',
      `poker_tournaments_stuck_completing ${s.stuckCompleting}`,
      '# HELP poker_tournament_seatless_phantoms Entrants in a RUNNING event holding chips with no open seat anywhere in it',
      '# TYPE poker_tournament_seatless_phantoms gauge',
      `poker_tournament_seatless_phantoms ${s.seatlessPhantoms}`,
      `# HELP poker_tournaments_unpaid_completed Tournaments COMPLETED in the last ${UNPAID_LOOKBACK_HOURS}h with a prize pool and not one prize payment`,
      '# TYPE poker_tournaments_unpaid_completed gauge',
      `poker_tournaments_unpaid_completed ${s.unpaidCompleted}`,
      '# HELP poker_tournaments_seat_first_waiting SNG/Spin open past a nominal start time. Their ordinary resting state - informational, do NOT alert on it.',
      '# TYPE poker_tournaments_seat_first_waiting gauge',
      `poker_tournaments_seat_first_waiting ${s.seatFirstWaiting}`,
      '# HELP poker_tournament_metrics_stale_seconds Age of the tournament snapshot. A failed read keeps the last good values, so THIS is what proves the gauges above are current.',
      '# TYPE poker_tournament_metrics_stale_seconds gauge',
      `poker_tournament_metrics_stale_seconds ${staleSeconds}`,
    ];
  }
}
