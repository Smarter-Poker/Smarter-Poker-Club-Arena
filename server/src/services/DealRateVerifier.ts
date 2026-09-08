/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  DEAL-RATE VERIFIER — liveness the engine cannot fake
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 *
 * Every freeze detector in this engine is the engine judging itself.
 * `/health` decides the process is alive from `msSinceProgress()`, which is
 * set by `markProgress()`, which the engine calls about its own work. Docker's
 * healthcheck trusts /health, autoheal trusts Docker, and the host supervisor
 * trusts autoheal. Four layers, one belief underneath all of them.
 *
 * On 2026-08-22 that belief was wrong for six hours. The dealing loop's
 * watchdog concluded 1,603 times that healthy tables were dead and killed them
 * — every running cash table, 22-30 times each — and nothing above it could
 * disagree, because everything above it was reading the same number.
 *
 * A self-check cannot catch a wrong self-assessment. So this one does not ask
 * the engine anything. It asks the DATABASE a question the engine cannot
 * answer wrongly:
 *
 *     I own N tables that should be dealing right now.
 *     How many hands did you actually record for them?
 *
 * If N is meaningful and the answer is zero for several minutes, the process
 * is not dealing, whatever its timers believe. That is true for a wedged event
 * loop, a broken write path, a lie in markProgress, and for failure modes
 * nobody has thought of yet — because it measures the PRODUCT, not a
 * mechanism.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT WILL NOT RESTART A HEALTHY FLEET
 *
 * A false positive here restarts every table at once, so every branch below
 * fails SAFE — silence is only ever concluded from a positive answer:
 *
 *  1. A THROWN QUERY IS NOT EVIDENCE. If the database is unreachable the
 *     counter RESETS. "We could not ask" must never be read as "nothing is
 *     happening" — the same inversion `heartbeatTables` avoids when it returns
 *     [] rather than "we lost every table". Notably a real Supabase outage
 *     happened during this work, at 02:16 UTC, and this is the branch that
 *     keeps it from becoming a fleet-wide restart on top of an outage.
 *
 *  2. IT ONLY JUDGES A FLEET BIG ENOUGH TO JUDGE. Below MIN_TABLES_TO_JUDGE
 *     dealable tables it stands down. One table between hands is not evidence
 *     of anything; forty silent ones are.
 *
 *  3. PAUSED IS NOT DEAD. Tables parked by design — synchronized breaks,
 *     hand-for-hand — are excluded, the same rule the turn watchdog and the
 *     zombie reaper already follow.
 *
 *  4. IT NEEDS SUSTAINED SILENCE. One quiet minute is normal; the counter
 *     needs CONSECUTIVE_TO_DECLARE_DEAD consecutive confirmations, and any
 *     single hand anywhere resets it to zero.
 *
 *  5. IT ONLY REPORTS. It sets a flag on /health. Restarting is Docker's
 *     decision, through the same path it already uses — this adds evidence,
 *     never a new way to kill the process.
 */

import { supabase } from './supabase.js';
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';
import { reportError } from './errorReporter.js';
import { IN_LIST_CHUNK } from './supabase/chunkedIn.js';
import { raiseEngineAlert, resolveEngineAlert } from './engineAlerts.js';

/** How often to ask the database. */
const CHECK_INTERVAL_MS = 60_000;
/** The window each check looks back over. */
const LOOKBACK_MS = 3 * 60_000;
/** Below this many dealable tables, the sample is too small to mean anything. */
const MIN_TABLES_TO_JUDGE = 3;
/** Consecutive confirmed-silent checks before the process is called dead. */
const CONSECUTIVE_TO_DECLARE_DEAD = 3;

/**
 * ── THE CANARY HOLE ────────────────────────────────────────────────────────
 *
 * MIN_TABLES_TO_JUDGE makes this verifier stand down on a small fleet, which is
 * right — one table between hands proves nothing. But it means a failure that
 * ALSO empties the fleet silences the detector completely: zero dealable tables
 * reads as "nothing to check" rather than "the platform is gone".
 *
 * The horse fleet keeps dozens of tables dealing around the clock, so the floor
 * is not a normal state — losing it IS the incident. Falling below the floor is
 * therefore its own alarm, and the one that would catch a catastrophe the
 * deal-rate check cannot even see.
 */
const FLEET_FLOOR_TABLES = 3;
/** Consecutive checks below the floor before it is called in. */
const CONSECUTIVE_BELOW_FLOOR = 3;

/**
 * ── DO NOT ALARM WHILE STILL BOOTING ───────────────────────────────────────
 *
 * A cold start has no dealable tables for a while: cleanupStaleData runs first
 * and is heavy, then the horse fleet seats, then discovery spawns ~50 engines,
 * and only then does a table become dealable. Measured on a real production
 * boot: 0 tables at 62s, 59 tables at 139s.
 *
 * Three checks is three minutes, so that boot cleared it — but only just, and
 * the boots that would NOT clear it are precisely the slow ones, which happen
 * when the database is already degraded. That is the worst possible moment to
 * email a critical alarm about a fleet that is simply still starting.
 *
 * An alarm that cries wolf during a bad moment is worse than no alarm, because
 * the next real one gets ignored. So the floor is not judged until the process
 * has had a fair chance to fill it. Deal-rate silence is unaffected: that check
 * needs tables to exist before it can conclude anything anyway.
 */
const STARTUP_GRACE_MS = 5 * 60_000;

/** Kill-rate: recovery events in this window that count as a storm. */
const KILL_WINDOW_MS = 15 * 60_000;
/**
 * On 2026-08-22 the fleet sustained ~4.5 kills/min for six hours. Healthy is
 * now under one an hour, so 30 in fifteen minutes is unambiguous without being
 * trigger-happy about a single bad table recovering itself.
 */
const KILL_STORM_THRESHOLD = 30;

const COMPONENT = 'club-arena-engine';

export interface DealRateSnapshot {
  /** Consecutive checks where the DB confirmed zero hands on a dealing fleet. */
  silentChecks: number;
  /** True once silence is sustained enough to be a verdict. */
  dbConfirmedDead: boolean;
  /** Dealable tables seen at the last check. */
  tablesExpectedDealing: number;
  /** Hands the DB reported at the last check; null when it could not be asked. */
  handsInWindow: number | null;
  /** When the last check completed. 0 = never run. */
  lastCheckedAt: number;
  /** Consecutive checks with fewer dealable tables than the floor. */
  belowFloorChecks: number;
  /** Engine kills seen in the kill window; null when it could not be asked. */
  killsInWindow: number | null;
}

export class DealRateVerifier {
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  /**
   * A verifier pass is mostly reads, but its verdict posts a durable alert.
   * Clearing the clock cannot let an old leader's read or alert delivery race
   * the replacement leader after ownership moves.
   */
  private readonly lifecycleJobs = new Set<Promise<unknown>>();
  private lifecycleGeneration = 0;
  private stopOperation: Promise<void> | null = null;
  /** Direct check() probes are valid before start, but not after stop. */
  private acceptingChecks = true;
  /** When this process started watching — see STARTUP_GRACE_MS. */
  private readonly startedAt = Date.now();
  private silentChecks = 0;
  private tablesExpectedDealing = 0;
  private handsInWindow: number | null = null;
  private lastCheckedAt = 0;
  private belowFloorChecks = 0;
  private killsInWindow: number | null = null;

  /**
   * @param dealingTableIds returns the tables this process believes it owns
   *        AND believes should be dealing right now. The verifier's job is to
   *        find out whether that belief is producing hands.
   */
  constructor(private readonly dealingTableIds: () => string[]) {}

  private lifecycleIsCurrent(generation: number): boolean {
    return this.isRunning && this.lifecycleGeneration === generation;
  }

  private lifecycleEnded(generation: number | null): boolean {
    return generation !== null && !this.lifecycleIsCurrent(generation);
  }

  private trackLifecycleJob<T>(job: Promise<T>): Promise<T> {
    const tracked = job.finally(() => this.lifecycleJobs.delete(tracked));
    this.lifecycleJobs.add(tracked);
    return tracked;
  }

  private openLifecycleScope(): () => void {
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    void this.trackLifecycleJob(completion);
    return release;
  }

  private launchAlert(job: Promise<unknown>, context: string): void {
    void this.trackLifecycleJob(job).catch((error) => reportError(error, context));
  }

  private launchCheck(generation: number): void {
    if (!this.lifecycleIsCurrent(generation)) return;
    void this.trackLifecycleJob(this.check()).catch((error) =>
      reportError(error, 'DealRateVerifier.detached_check')
    );
  }

  private async drainLifecycleJobs(): Promise<void> {
    while (this.lifecycleJobs.size > 0) {
      await Promise.allSettled([...this.lifecycleJobs]);
    }
  }

  start(): void {
    if (this.stopOperation) {
      console.warn('[DealRateVerifier] Start refused while the prior generation is stopping');
      return;
    }
    if (this.timer) return;
    this.isRunning = true;
    this.acceptingChecks = true;
    const generation = ++this.lifecycleGeneration;
    this.timer = setInterval(() => this.launchCheck(generation), CHECK_INTERVAL_MS);
    (this.timer as { unref?: () => void }).unref?.();
    console.log('[DealRateVerifier] watching the fleet from the database');
  }

  stop(): Promise<void> {
    if (this.stopOperation) return this.stopOperation;

    // Synchronous admission fence; the promise below only joins work which
    // crossed the boundary before leadership was revoked.
    this.isRunning = false;
    this.acceptingChecks = false;
    this.lifecycleGeneration++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;

    const drain = this.drainLifecycleJobs();
    const trackedStop = drain.finally(() => {
      if (this.stopOperation === trackedStop) this.stopOperation = null;
    });
    this.stopOperation = trackedStop;
    return trackedStop;
  }

  snapshot(): DealRateSnapshot {
    return {
      silentChecks: this.silentChecks,
      dbConfirmedDead: this.silentChecks >= CONSECUTIVE_TO_DECLARE_DEAD,
      tablesExpectedDealing: this.tablesExpectedDealing,
      handsInWindow: this.handsInWindow,
      lastCheckedAt: this.lastCheckedAt,
      belowFloorChecks: this.belowFloorChecks,
      killsInWindow: this.killsInWindow,
    };
  }

  /**
   * A kill storm is not a freeze — the tables come back — so it must not touch
   * liveness. But it is the exact signature of 2026-08-22, when 1,603 kills
   * over six hours went entirely unreported, and it deserves to be noticed in
   * minutes rather than found by somebody reading the database later.
   */
  private async checkKillRate(generation: number | null): Promise<void> {
    const since = new Date(Date.now() - KILL_WINDOW_MS).toISOString();
    try {
      const { count, error } = await supabase
        .from('engine_recovery_events')
        .select('id', { count: 'exact', head: true })
        .gt('created_at', since);
      if (this.lifecycleEnded(generation)) return;
      if (error) {
        this.killsInWindow = null;
        return;
      }
      const kills = count ?? 0;
      this.killsInWindow = kills;
      if (kills >= KILL_STORM_THRESHOLD) {
        this.launchAlert(
          raiseEngineAlert({
            alertname: 'ClubArenaEngineKillStorm',
            severity: 'critical',
            component: COMPONENT,
            summary:
              kills +
              ' engine kills in ' +
              Math.round(KILL_WINDOW_MS / 60_000) +
              'min - tables are being destroyed and rebuilt in a loop',
            description:
              'Healthy is under one an hour. Read engine_recovery_events.detail: it names ' +
              'the phase or stage each kill happened in.',
            labels: { kills: String(kills) },
          }),
          'DealRateVerifier.kill_storm_alert_failed'
        );
      } else {
        this.launchAlert(
          resolveEngineAlert(
            'ClubArenaEngineKillStorm',
            COMPONENT,
            'Kill rate back to normal (' + kills + ' in window)'
          ),
          'DealRateVerifier.kill_storm_resolve_failed'
        );
      }
    } catch {
      // Same rule as everywhere else here: could-not-ask is not evidence.
      if (this.lifecycleEnded(generation)) return;
      this.killsInWindow = null;
    }
  }

  /**
   * Has the WHOLE fleet dealt nothing for a full startup-grace window?
   *
   * Deliberately unfiltered by table: when the fleet has collapsed there are no
   * table ids left to filter by, which is precisely the hole this closes. It
   * asks the one question that outlives a restart — "has this platform dealt a
   * hand recently" — so a process two minutes old can still tell the difference
   * between booting and dark.
   *
   * Returns false when the database cannot be asked. Could-not-ask is not
   * evidence, the same rule every other guard in this file follows; a flaky
   * database must not manufacture a critical alarm.
   */
  private async fleetDarkAcrossRestarts(): Promise<boolean> {
    const since = new Date(Date.now() - STARTUP_GRACE_MS).toISOString();
    try {
      const { count, error } = await supabase
        .from('hand_history')
        .select('id', { count: 'exact', head: true })
        .gt('created_at', since);
      if (error) return false;
      return (count ?? 0) === 0;
    } catch {
      return false;
    }
  }

  /** Exposed for tests; the timer calls this. */
  async check(): Promise<void> {
    if (!this.acceptingChecks) return;
    const releaseLifecycle = this.openLifecycleScope();
    const generation = this.isRunning ? this.lifecycleGeneration : null;
    try {
      if (this.lifecycleEnded(generation)) return;
      /**
       * A PLATFORM-WIDE FREEZE IS NOT A FLEET COLLAPSE (Dan 2026-09-01).
       *
       * During the :55 maintenance break every table is parked on purpose, so
       * both of this class's questions - "is the fleet above the floor?" and
       * "are dealing tables producing hands?" - have a denominator of zero for
       * five legitimate minutes. The first attempt at handling this fed the
       * verifier an empty table list from GameServer, which was WORSE than
       * nothing: an empty list IS the below-floor condition, so it primed
       * `ClubArenaFleetFloorLost` (critical) to fire on the third tick of
       * every single break, hourly, forever.
       *
       * The check is skipped outright instead, and the counters are reset so a
       * pre-break streak cannot resume where it left off and fire one tick
       * after the thaw on evidence gathered before the freeze.
       */
      if (isMaintenanceFrozen()) {
        this.belowFloorChecks = 0;
        this.silentChecks = 0;
        this.handsInWindow = null;
        this.lastCheckedAt = Date.now();
        return;
      }

      const tableIds = this.dealingTableIds();
      this.tablesExpectedDealing = tableIds.length;

      // Guard 2: too small a fleet to conclude anything about the DEAL RATE
      // from. But standing down silently is the canary hole - a failure that also
      // empties the fleet would switch this detector off exactly when it matters.
      // So the floor is watched separately, and losing it is its own alarm.
      if (tableIds.length < FLEET_FLOOR_TABLES) {
        /**
         * ── A RESTART LOOP NEVER OUTLIVES THE STARTUP GRACE (2026-08-30) ─────
         *
         * The grace is right: a cold start genuinely has no dealable tables for
         * minutes, and crying wolf during a slow boot is worse than not alarming
         * at all. But `startedAt` is THIS PROCESS's clock, and it resets on every
         * restart - so the grace silences the alarm completely in the one
         * scenario it exists for.
         *
         * Observed on 2026-08-30: Supabase went into RESIZING, the engine could
         * not win its leadership claim, and it restarted roughly every two
         * minutes for over forty minutes. Every one of those processes died well
         * inside the five-minute grace, so `belowFloorChecks` was never even
         * INCREMENTED, let alone reached three. The entire fleet was dark, the
         * detector written for exactly that was structurally unable to fire, and
         * nobody was told. It was found by a person looking at a lobby.
         *
         * So the grace now has to justify itself against something that survives
         * a restart. The database remembers when the fleet last dealt a hand; a
         * booting engine and a dead one look identical from inside the process
         * and completely different from there.
         */
        if (Date.now() - this.startedAt < STARTUP_GRACE_MS) {
          const darkAcrossRestarts = await this.fleetDarkAcrossRestarts();
          if (this.lifecycleEnded(generation)) return;
          if (!darkAcrossRestarts) {
            // Genuinely still booting - hands are being dealt somewhere, or the
            // database could not be asked, and neither is evidence of collapse.
            this.silentChecks = 0;
            this.handsInWindow = null;
            this.lastCheckedAt = Date.now();
            return;
          }
          // Not booting: nothing has dealt anywhere for the whole grace window.
          // Fall through and judge the floor on this process's first check.
        }
        this.belowFloorChecks++;
        this.silentChecks = 0;
        this.handsInWindow = null;
        this.lastCheckedAt = Date.now();
        if (this.belowFloorChecks >= CONSECUTIVE_BELOW_FLOOR) {
          this.launchAlert(
            raiseEngineAlert({
              alertname: 'ClubArenaFleetFloorLost',
              severity: 'critical',
              component: COMPONENT,
              summary:
                'Only ' + tableIds.length + ' table(s) should be dealing - the fleet has collapsed',
              description:
                'The horse fleet normally keeps dozens of tables dealing around the clock. ' +
                'Below ' +
                FLEET_FLOOR_TABLES +
                ' the deal-rate check cannot judge anything, so ' +
                'this is the alarm that covers it. Check HorseFleetManager and table discovery.',
              labels: { tables: String(tableIds.length) },
            }),
            'DealRateVerifier.fleet_floor_alert_failed'
          );
        }
        return;
      }
      this.belowFloorChecks = 0;
      this.launchAlert(
        resolveEngineAlert('ClubArenaFleetFloorLost', COMPONENT, 'Fleet is back above the floor'),
        'DealRateVerifier.fleet_floor_resolve_failed'
      );

      const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
      try {
        /* THE ID LIST IS CHUNKED, AND A FAILURE IS SAID OUT LOUD (2026-09-03).
         `tableIds` is every table this process is dealing - 1,131 on the floor
         the day this was written - and one `.in()` that long is a ~40 KB URL
         that PostgREST answers with HTTP 400 (the ceiling is about 675 ids).
         The guard below then read the 400 as "not evidence of silence", reset
         the counter and returned, every cycle, forever: the watchdog whose
         only job is noticing the fleet stopped dealing had silently switched
         itself off, and precisely at the scale where a fleet outage matters.
         It also said nothing, so nothing else could notice either. */
        let count = 0;
        let error: { message: string } | null = null;
        for (let i = 0; i < tableIds.length; i += IN_LIST_CHUNK) {
          const { count: c, error: e } = await supabase
            .from('hand_history')
            .select('id', { count: 'exact', head: true })
            .in('table_id', tableIds.slice(i, i + IN_LIST_CHUNK))
            .gt('created_at', since);
          if (this.lifecycleEnded(generation)) return;
          if (e) {
            error = e;
            reportError(
              new Error(
                `[DealRateVerifier] hand count failed on the chunk at ${i} of ${tableIds.length}: ${e.message}`
              ),
              'DealRateVerifier.hand_count_chunk_failed'
            );
            break;
          }
          count += c ?? 0;
        }

        // Guard 1: an error is NOT evidence of silence.
        if (error) {
          this.silentChecks = 0;
          this.handsInWindow = null;
          this.lastCheckedAt = Date.now();
          return;
        }

        const hands = count ?? 0;
        this.handsInWindow = hands;
        this.lastCheckedAt = Date.now();

        await this.checkKillRate(generation);
        if (this.lifecycleEnded(generation)) return;

        if (hands > 0) {
          // Guard 4: a single hand anywhere clears the alarm.
          this.silentChecks = 0;
          this.launchAlert(
            resolveEngineAlert('ClubArenaFleetSilent', COMPONENT, 'Hands are being dealt again'),
            'DealRateVerifier.fleet_silent_resolve_failed'
          );
          return;
        }

        this.silentChecks++;
        if (this.silentChecks >= CONSECUTIVE_TO_DECLARE_DEAD) {
          this.launchAlert(
            raiseEngineAlert({
              alertname: 'ClubArenaFleetSilent',
              severity: 'critical',
              component: COMPONENT,
              summary:
                'ZERO hands in ' +
                Math.round(LOOKBACK_MS / 60_000) +
                'min across ' +
                tableIds.length +
                ' tables that should be dealing',
              description:
                'The database confirms no hands were recorded while this process believes ' +
                'these tables are dealing. /health is reporting liveness "dead"; Docker will ' +
                'restart the container. If this repeats, the restart is not fixing the cause.',
              labels: { tables: String(tableIds.length) },
            }),
            'DealRateVerifier.fleet_silent_alert_failed'
          );
        }
        reportError(
          new Error(
            'Database confirms ZERO hands in ' +
              Math.round(LOOKBACK_MS / 60_000) +
              'min across ' +
              tableIds.length +
              ' tables this process says should be dealing (' +
              this.silentChecks +
              '/' +
              CONSECUTIVE_TO_DECLARE_DEAD +
              ')'
          ),
          'DealRateVerifier.fleet_silent',
          { tables: tableIds.length, silentChecks: this.silentChecks }
        );
      } catch (err) {
        // Guard 1 again, for a throw rather than a returned error.
        if (this.lifecycleEnded(generation)) return;
        this.silentChecks = 0;
        this.handsInWindow = null;
        this.lastCheckedAt = Date.now();
        reportError(err, 'DealRateVerifier.check_threw');
      }
    } finally {
      releaseLifecycle();
    }
  }
}
