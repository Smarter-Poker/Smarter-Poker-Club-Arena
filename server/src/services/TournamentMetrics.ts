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
  /** Each RUNNING MTT is checked independently of cash games or other events. */
  stalledRunning: number;
  /**
   * The denominator stalledRunning never had (2026-09-26): RUNNING MTTs in the
   * same eligible population - past startup grace, not on a break, not inside
   * an add-on - that DID produce a hand in the window. null when the database
   * function predates the column: "could not tell" is not zero, and a zero here
   * would read as "the whole fleet stopped" (CLAUDE.md 10.86 rule 1).
   */
  progressingRunning: number | null;
  overdueBreaks: number;
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
  stalledRunning: 0,
  progressingRunning: null,
  overdueBreaks: 0,
  seatFirstWaiting: 0,
  collectedAt: 0,
};

/**
 * How stale the database snapshot may be before `poker_tournament_fleet_unserved`
 * refuses to answer. The refresh runs every 60s, so 300s is five missed reads:
 * long enough that a single slow query is not an outage, short enough that the
 * gauge cannot go on asserting "nothing is served" from a number nobody has
 * checked since the last engine restart. See the fail-closed note in the header.
 */
export const FLEET_SNAPSHOT_MAX_AGE_SECONDS = 300;

/** How long a tournament may sit past its start time before it is overdue. */
export const OVERDUE_START_MINUTES = 10;
/** How long COMPLETING is tolerated before it counts as stuck. */
export const STUCK_COMPLETING_MINUTES = 10;
/** How far back the unpaid-prize check looks. */
export const UNPAID_LOOKBACK_HOURS = 6;
/** Seven-day maximum hand: 214.389s; p99 80.146s over 2,101,203 hands. */
export const STALLED_MTT_MINUTES = 15;
/** Extra time after the persisted break/add-on deadline, beyond the five-minute break. */
export const OVERDUE_BREAK_GRACE_MINUTES = 10;

/**
 * LAUNCH LATENESS (2026-10-19). tournaments.started_at is written equal to
 * start_time, so it can never show a late launch; the first dealt hand can.
 * From 2026-10-12 to 2026-10-18, 20-30% of scheduled MTTs dealt their first
 * hand over 60 s late and 9-14% over 120 s (worst 7,648 s), and nothing could
 * see it. fn_tournament_launch_lateness_metrics measures from
 * hand_history.started_at; started_at keeps its meaning.
 */
export const LATE_START_SECONDS = 120;
/**
 * hand_history is written when a hand ENDS (created_at - started_at p99 77 s),
 * so "no hand recorded yet" needs this much more before it means late: an
 * on-time first hand still in play must not read as a late start.
 */
export const LATE_START_HEADROOM_SECONDS = 120;
/** How far back a late first hand stays counted after it is recorded. */
export const LATE_START_WINDOW_MINUTES = 15;

/** The launch-lateness read. collectedAt 0 = never answered: unknown, not zero. */
export interface LaunchLatenessSnapshot {
  lateFirstHands: number;
  lateWaiting: number;
  worstLateSeconds: number;
  collectedAt: number;
}

export class TournamentMetrics {
  private snapshot: TournamentMetricsSnapshot = { ...EMPTY };
  /**
   * Kept apart from the snapshot on purpose: the launch-lateness read is a
   * newer, independent function, and its failure must not freeze the
   * established tournament gauges (or the other way round). Its own staleness
   * gauge says when it is blind.
   */
  private lateness: LaunchLatenessSnapshot = {
    lateFirstHands: 0,
    lateWaiting: 0,
    worstLateSeconds: 0,
    collectedAt: 0,
  };
  private refreshing = false;
  private stopped = false;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Consecutive failed refreshes, for a single escalation rather than a flood. */
  private consecutiveFailures = 0;
  private reportedBlind = false;

  constructor(private readonly refreshMs = 60_000) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.generation++;
    // Refresh once immediately so the first scrape after a boot is not blind
    // for a whole interval, then on the interval.
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    // Never hold the process open for a metrics timer.
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get(): TournamentMetricsSnapshot {
    return this.snapshot;
  }

  getLaunchLateness(): LaunchLatenessSnapshot {
    return this.lateness;
  }

  /**
   * Publish a launch-lateness read only when every count is a nonnegative
   * integer. Anything else keeps the last good read, whose age the staleness
   * gauge reports (CLAUDE.md 10.86 rules 1 and 2).
   */
  private absorbLateness(
    read: PromiseSettledResult<{ data: unknown; error: { message?: string } | null }>
  ): void {
    if (read.status !== 'fulfilled' || read.value.error) return;
    const data = read.value.data;
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
    if (!row || typeof row !== 'object') return;
    const count = (value: unknown): number | null => {
      if (typeof value === 'string' && !/^[0-9]+$/.test(value)) return null;
      if (typeof value !== 'number' && typeof value !== 'string') return null;
      const n = Number(value);
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    };
    const lateFirstHands = count(row.late_first_hands);
    const lateWaiting = count(row.late_waiting);
    const worstLateSeconds = count(row.worst_late_seconds);
    if (lateFirstHands === null || lateWaiting === null || worstLateSeconds === null) return;
    this.lateness = { lateFirstHands, lateWaiting, worstLateSeconds, collectedAt: Date.now() };
  }

  /**
   * Read the counts. Never throws, never zeroes a good snapshot on failure.
   *
   * The established counts and the per-event progress aggregate are independent
   * read-only RPCs. Both must return complete counts before a fresh snapshot is
   * published. Missing or malformed evidence keeps the last good snapshot stale.
   */
  async refresh(): Promise<void> {
    if (this.refreshing || this.stopped) return;
    const generation = this.generation;
    this.refreshing = true;
    try {
      const [countRead, progressRead, latenessRead] = await Promise.allSettled([
        supabase.rpc('fn_tournament_metrics', {
          p_overdue_minutes: OVERDUE_START_MINUTES,
          p_completing_minutes: STUCK_COMPLETING_MINUTES,
          p_unpaid_hours: UNPAID_LOOKBACK_HOURS,
        }),
        supabase.rpc('fn_tournament_progress_metrics', {
          p_stalled_minutes: STALLED_MTT_MINUTES,
          p_break_grace_minutes: OVERDUE_BREAK_GRACE_MINUTES,
        }),
        supabase.rpc('fn_tournament_launch_lateness_metrics', {
          p_late_seconds: LATE_START_SECONDS,
          p_headroom_seconds: LATE_START_HEADROOM_SECONDS,
          p_window_minutes: LATE_START_WINDOW_MINUTES,
        }),
      ]);
      if (this.stopped || generation !== this.generation) return;
      this.absorbLateness(latenessRead);
      if (countRead.status === 'rejected') throw countRead.reason;
      if (progressRead.status === 'rejected') throw progressRead.reason;
      const counts = countRead.value;
      const progress = progressRead.value;
      const row = Array.isArray(counts.data) ? counts.data[0] : counts.data;
      const eventProgress = Array.isArray(progress.data) ? progress.data[0] : progress.data;
      if (counts.error || progress.error || !row || !eventProgress) {
        this.noteFailure(counts.error?.message ?? progress.error?.message ?? 'no row returned');
        return;
      }

      const n = (value: unknown): number => {
        if (
          (typeof value !== 'number' && typeof value !== 'string') ||
          (typeof value === 'string' && !/^[0-9]+$/.test(value))
        )
          throw new Error('required tournament count is missing or malformed');
        const count = Number(value);
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new Error('required tournament count is not a nonnegative integer');
        }
        return count;
      };

      this.snapshot = {
        running: n(row.running),
        registering: n(row.registering),
        overdueStart: n(row.overdue_start),
        stuckCompleting: n(row.stuck_completing),
        seatlessPhantoms: n(row.seatless_phantoms),
        unpaidCompleted: n(row.unpaid_completed),
        stalledRunning: n(eventProgress.stalled_running),
        progressingRunning:
          eventProgress.progressing_running === undefined
            ? null
            : n(eventProgress.progressing_running),
        overdueBreaks: n(eventProgress.overdue_breaks),
        seatFirstWaiting: n(row.seat_first_waiting),
        collectedAt: Date.now(),
      };
      this.consecutiveFailures = 0;
      this.reportedBlind = false;
    } catch (err) {
      if (this.stopped || generation !== this.generation) return;
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
   *
   * ── THE OTHER HALF OF THE MEASUREMENT (2026-09-09) ─────────────────────────
   *
   * The header of this file says the valuable signal is "a tournament that
   * should be running is not", and that an engine reporting only on what it
   * OWNS can never see it, "because the failure IS the absence of a manager".
   * Both halves are true, and until today only one of them was published: the
   * database said 120 tournaments were RUNNING and nothing said how many this
   * process was actually running.
   *
   * Measured on production 2026-09-09 05:52 UTC, and this is why it matters:
   *
   *     /health   activeTables: 102, activeTournaments: 0
   *     /metrics  poker_tournaments_running 120
   *               poker_tournament_elimination_scheduler_registered 0
   *
   * A full cash fleet and not one of a hundred and twenty tournaments - with
   * `liveness: ok`, because every liveness branch was satisfied: the cash
   * tables were progressing, the discovery loop was ticking, and
   * `barrenLeaderDead` needs `tables.length === 0`, which a busy cash fleet can
   * never be. Thirteen events had dealt no hand for over an hour, the oldest
   * for fifteen, with 183 players sitting in them, and nothing anywhere said so.
   *
   * That is `EngineLivenessVerdict`'s own documented failure mode one level up:
   * a signal that reads healthy because it was measuring the wrong denominator.
   * The engine is the only thing that knows both numbers, so it computes the
   * comparison here rather than leaving a rule to guess it from series that do
   * not carry leadership or boot state:
   *
   *   - a STANDBY instance owns nothing by design, so it never reports unserved;
   *   - a BOOTING instance has not finished adopting, so neither does it;
   *   - a STALE snapshot means `running` is a number nobody has re-read, so the
   *     gauge refuses rather than asserting from it (10.86 rule 1: "I could not
   *     tell" is its own outcome).
   *
   * It is deliberately NOT wired into the liveness verdict. Killing a process
   * that holds a hundred live cash tables to fix an unserved tournament fleet
   * would void every hand in flight, which is the exact regression the three
   * notes in `EngineLivenessVerdict.ts` were each written about.
   */
  toPrometheus(
    fleet: { owned: number; isLeader: boolean; stillBooting: boolean } = {
      owned: 0,
      isLeader: false,
      stillBooting: true,
    }
  ): string[] {
    const s = this.snapshot;
    const staleSeconds =
      s.collectedAt === 0 ? 86_400 : Math.max(0, Math.round((Date.now() - s.collectedAt) / 1000));

    const late = this.lateness;
    const latenessKnown = late.collectedAt !== 0;
    const latenessStaleSeconds = latenessKnown
      ? Math.max(0, Math.round((Date.now() - late.collectedAt) / 1000))
      : 86_400;

    const owned = Math.max(0, Math.floor(fleet.owned));
    const unserved =
      fleet.isLeader &&
      !fleet.stillBooting &&
      staleSeconds <= FLEET_SNAPSHOT_MAX_AGE_SECONDS &&
      s.running > 0 &&
      owned === 0
        ? 1
        : 0;

    return [
      '# HELP poker_tournaments_owned Tournament managers THIS engine holds. The database half of this comparison is poker_tournaments_running.',
      '# TYPE poker_tournaments_owned gauge',
      `poker_tournaments_owned ${owned}`,
      '# HELP poker_tournament_fleet_unserved 1 when this leader, past boot and on a fresh snapshot, owns NO manager while the database says tournaments are RUNNING. Never set on a standby, a booting instance, or a stale read.',
      '# TYPE poker_tournament_fleet_unserved gauge',
      `poker_tournament_fleet_unserved ${unserved}`,
      '# HELP poker_mtt_stalled_running RUNNING MTTs with no recent hand for their own event, excluding active breaks, add-ons and startup grace.',
      '# TYPE poker_mtt_stalled_running gauge',
      `poker_mtt_stalled_running ${s.stalledRunning}`,
      // Published only when the database answered it. MttFleetNotDealing reads
      // progressing / (progressing + stalled); an absent series leaves that rule
      // silent rather than firing on an invented zero.
      ...(s.progressingRunning === null
        ? []
        : [
            '# HELP poker_mtt_progressing_running RUNNING MTTs in the same eligible population as poker_mtt_stalled_running that DID produce a hand for their own event in the window.',
            '# TYPE poker_mtt_progressing_running gauge',
            `poker_mtt_progressing_running ${s.progressingRunning}`,
          ]),
      '# HELP poker_mtt_overdue_breaks MTTs still on break beyond their persisted break or add-on deadline and grace period.',
      '# TYPE poker_mtt_overdue_breaks gauge',
      `poker_mtt_overdue_breaks ${s.overdueBreaks}`,
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
      // Launch lateness. HELP/TYPE always, a sample only once the database has
      // answered: before that the count is unknown, and an invented zero would
      // read as "every MTT started on time".
      `# HELP poker_mtt_late_first_hands MTTs whose first hand was dealt over ${LATE_START_SECONDS}s after start_time (hand_history.started_at), recorded in the last ${LATE_START_WINDOW_MINUTES}m.`,
      '# TYPE poker_mtt_late_first_hands gauge',
      ...(latenessKnown ? [`poker_mtt_late_first_hands ${late.lateFirstHands}`] : []),
      `# HELP poker_mtt_late_start_waiting MTTs still ANNOUNCED/REGISTERING/RUNNING with no recorded hand ${LATE_START_SECONDS + LATE_START_HEADROOM_SECONDS}s after start_time.`,
      '# TYPE poker_mtt_late_start_waiting gauge',
      ...(latenessKnown ? [`poker_mtt_late_start_waiting ${late.lateWaiting}`] : []),
      '# HELP poker_mtt_worst_late_start_seconds Largest launch lateness among the MTTs counted by the two gauges above; 0 when none.',
      '# TYPE poker_mtt_worst_late_start_seconds gauge',
      ...(latenessKnown ? [`poker_mtt_worst_late_start_seconds ${late.worstLateSeconds}`] : []),
      '# HELP poker_mtt_launch_lateness_stale_seconds Age of the launch-lateness read. 86400 when it has never answered; the lateness gauges are absent until it does.',
      '# TYPE poker_mtt_launch_lateness_stale_seconds gauge',
      `poker_mtt_launch_lateness_stale_seconds ${latenessStaleSeconds}`,
      '# HELP poker_tournament_metrics_stale_seconds Age of the tournament snapshot. A failed read keeps the last good values, so THIS is what proves the gauges above are current.',
      '# TYPE poker_tournament_metrics_stale_seconds gauge',
      `poker_tournament_metrics_stale_seconds ${staleSeconds}`,
    ];
  }
}
