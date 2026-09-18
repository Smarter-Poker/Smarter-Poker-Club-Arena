/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HORSE FLEET METRICS — the fleet reports what it cannot finish
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-17, phase 3 of the horse programme)
 *
 * On 2026-09-17 20:20 UTC the database held 835 RUNNING tournaments. 547 of
 * them were DECIDED: one player left 'playing', the cards done, the finish
 * refused or never asked for. The oldest had been decided for nine days. 547
 * horses sat in those games, one per game, waiting to be paid; 560 of the
 * tournaments could not finish because their entry fee had no accounting
 * batch behind it. Completions fell from 20-45 a minute to 3-11. Every one of
 * those numbers was found by a human typing SQL, because `/metrics` carried
 * `poker_tournaments_running` and `poker_tournaments_owned` and nothing that
 * said how many of the running ones were already over.
 *
 * The same afternoon a lock-order change produced 1,393 deadlocks in fourteen
 * minutes. The engine has no deadlock series; the Postgres log was the only
 * witness, and a person had to go and read it.
 *
 * WHAT IT PUBLISHES
 *
 *   poker_tournaments_decided_unfinished         RUNNING tournaments with at
 *                                                most one player still playing
 *                                                for longer than DECIDED_MINUTES
 *   poker_tournaments_decided_unfinished_oldest_minutes
 *   poker_horses_in_decided_games                seated horses at tables of
 *                                                decided tournaments
 *   poker_horses_seated_in_database              the database half of
 *                                                poker_horses_seated
 *   poker_tournaments_unbatched_fee_running      RUNNING tournaments holding a
 *                                                positive fee with no captured
 *                                                accounting batch: their finish
 *                                                is refused until somebody
 *                                                reconciles it
 *   poker_settlement_lane_waiters{lane}          backends waiting on the G, F
 *                                                or B advisory lane at the
 *                                                moment of the sample
 *   poker_settlement_lane_waiters_oldest_ms
 *   poker_db_deadlocks_total                     pg_stat_database.deadlocks,
 *                                                cumulative since stats reset
 *   poker_horse_fleet_metrics_stale_seconds      how old the snapshot is
 *
 * All of it comes from one read-only RPC, `fn_ca_horse_fleet_metrics`, on the
 * same footing as `TournamentMetrics`: the database is the only thing that
 * knows what should exist, and an engine reporting on what it owns can never
 * see a tournament nobody owns.
 *
 * FAIL-CLOSED, LOUDLY (same contract as TournamentMetrics)
 *
 *   - a failed refresh keeps the LAST GOOD snapshot rather than zeroing it;
 *   - `poker_horse_fleet_metrics_stale_seconds` always tells the truth about
 *     how old that snapshot is, and is itself alertable;
 *   - a collector that has never succeeded reports a day of staleness, not a
 *     tidy row of zeroes.
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

export interface HorseFleetSnapshot {
  running: number;
  decided: number;
  decidedOverMinutes: number;
  oldestDecidedMinutes: number;
  horsesSeated: number;
  horsesInDecided: number;
  unbatchedFeeRunning: number;
  laneGWaiters: number;
  laneFWaiters: number;
  laneBWaiters: number;
  laneWaitersOldestMs: number;
  deadlocksTotal: number;
  /** Epoch ms of the read that produced this. 0 = never succeeded. */
  collectedAt: number;
}

const EMPTY: HorseFleetSnapshot = {
  running: 0,
  decided: 0,
  decidedOverMinutes: 0,
  oldestDecidedMinutes: 0,
  horsesSeated: 0,
  horsesInDecided: 0,
  unbatchedFeeRunning: 0,
  laneGWaiters: 0,
  laneFWaiters: 0,
  laneBWaiters: 0,
  laneWaitersOldestMs: 0,
  deadlocksTotal: 0,
  collectedAt: 0,
};

/**
 * How long a tournament may sit decided before it counts as unfinished. A
 * finish takes seconds; the elimination scheduler's worst honest queue on
 * 2026-09-17 was fifteen to twenty minutes deep, so ten minutes says "this is
 * late" without saying it of a game that is merely in the queue. The gauge
 * carries the oldest age beside it, so the difference between late and
 * abandoned is on the scrape too.
 */
export const DECIDED_MINUTES = 10;

export class HorseFleetMetrics {
  private snapshot: HorseFleetSnapshot = { ...EMPTY };
  private refreshing = false;
  private stopped = false;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private reportedBlind = false;

  constructor(private readonly refreshMs = 60_000) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.generation++;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get(): HorseFleetSnapshot {
    return this.snapshot;
  }

  /** Read the counts. Never throws, never zeroes a good snapshot on failure. */
  async refresh(): Promise<void> {
    if (this.refreshing || this.stopped) return;
    const generation = this.generation;
    this.refreshing = true;
    try {
      const read = await supabase.rpc('fn_ca_horse_fleet_metrics', {
        p_decided_minutes: DECIDED_MINUTES,
      });
      if (this.stopped || generation !== this.generation) return;
      const row = Array.isArray(read.data) ? read.data[0] : read.data;
      if (read.error || !row) {
        this.noteFailure(read.error?.message ?? 'no row returned');
        return;
      }
      const n = (value: unknown): number => {
        if (
          (typeof value !== 'number' && typeof value !== 'string') ||
          (typeof value === 'string' && !/^[0-9]+$/.test(value))
        )
          throw new Error('required fleet count is missing or malformed');
        const count = Number(value);
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new Error('required fleet count is not a nonnegative integer');
        }
        return count;
      };
      this.snapshot = {
        running: n(row.running),
        decided: n(row.decided),
        decidedOverMinutes: n(row.decided_over_minutes),
        oldestDecidedMinutes: n(row.oldest_decided_minutes),
        horsesSeated: n(row.horses_seated),
        horsesInDecided: n(row.horses_in_decided),
        unbatchedFeeRunning: n(row.unbatched_fee_running),
        laneGWaiters: n(row.lane_g_waiters),
        laneFWaiters: n(row.lane_f_waiters),
        laneBWaiters: n(row.lane_b_waiters),
        laneWaitersOldestMs: n(row.lane_waiters_oldest_ms),
        deadlocksTotal: n(row.deadlocks_total),
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

  /** One report per outage, not one per attempt (see TournamentMetrics). */
  private noteFailure(reason: string): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= 3 && !this.reportedBlind) {
      this.reportedBlind = true;
      reportError(
        new Error(
          `[HorseFleetMetrics] ${this.consecutiveFailures} consecutive refresh failures (${reason}) - fleet gauges are STALE. poker_horse_fleet_metrics_stale_seconds is climbing and every decided-game alert is now blind.`
        ),
        'HorseFleetMetrics.refresh_failed'
      );
    }
  }

  /**
   * Prometheus text exposition. `stale_seconds` is emitted even when nothing
   * has ever been collected, and especially then.
   */
  toPrometheus(now: number = Date.now()): string[] {
    const s = this.snapshot;
    const staleSeconds =
      s.collectedAt === 0 ? 86_400 : Math.max(0, Math.round((now - s.collectedAt) / 1000));
    return [
      `# HELP poker_tournaments_decided_unfinished RUNNING tournaments with at most one player still playing for over ${DECIDED_MINUTES}m: the cards are done and nothing has finished them. The database half; poker_tournaments_owned is what this engine holds.`,
      '# TYPE poker_tournaments_decided_unfinished gauge',
      `poker_tournaments_decided_unfinished ${s.decidedOverMinutes}`,
      '# HELP poker_tournaments_decided_unfinished_oldest_minutes Age in minutes of the oldest decided RUNNING tournament, so late and abandoned read differently.',
      '# TYPE poker_tournaments_decided_unfinished_oldest_minutes gauge',
      `poker_tournaments_decided_unfinished_oldest_minutes ${s.oldestDecidedMinutes}`,
      '# HELP poker_horses_in_decided_games Seated horses at tables whose tournament is decided; each is a horse committed to a game nothing can happen in.',
      '# TYPE poker_horses_in_decided_games gauge',
      `poker_horses_in_decided_games ${s.horsesInDecided}`,
      '# HELP poker_horses_seated_in_database Horses the database seats right now (left_at IS NULL). The database half of poker_horses_seated.',
      '# TYPE poker_horses_seated_in_database gauge',
      `poker_horses_seated_in_database ${s.horsesSeated}`,
      '# HELP poker_tournaments_unbatched_fee_running RUNNING tournaments holding a positive entry fee with no captured accounting batch. fn_accounting_tournament_fee_net_plan refuses their finish until the fee is reconciled.',
      '# TYPE poker_tournaments_unbatched_fee_running gauge',
      `poker_tournaments_unbatched_fee_running ${s.unbatchedFeeRunning}`,
      '# HELP poker_settlement_lane_waiters Backends waiting on a settlement advisory lane at the moment of the sample (label: lane=G|F|B).',
      '# TYPE poker_settlement_lane_waiters gauge',
      `poker_settlement_lane_waiters{lane="G"} ${s.laneGWaiters}`,
      `poker_settlement_lane_waiters{lane="F"} ${s.laneFWaiters}`,
      `poker_settlement_lane_waiters{lane="B"} ${s.laneBWaiters}`,
      '# HELP poker_settlement_lane_waiters_oldest_ms Longest current wait on any settlement lane at the moment of the sample.',
      '# TYPE poker_settlement_lane_waiters_oldest_ms gauge',
      `poker_settlement_lane_waiters_oldest_ms ${s.laneWaitersOldestMs}`,
      '# HELP poker_db_deadlocks_total Deadlocks the database has detected, cumulative since its statistics were last reset (pg_stat_database.deadlocks).',
      '# TYPE poker_db_deadlocks_total counter',
      `poker_db_deadlocks_total ${s.deadlocksTotal}`,
      '# HELP poker_horse_fleet_metrics_stale_seconds Age of the fleet snapshot. A failed read keeps the last good values, so THIS is what proves the gauges above are current.',
      '# TYPE poker_horse_fleet_metrics_stale_seconds gauge',
      `poker_horse_fleet_metrics_stale_seconds ${staleSeconds}`,
    ];
  }
}
