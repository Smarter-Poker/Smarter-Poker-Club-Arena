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
import { fleetIsParkedByOwner, startFloorParkWatch, stopFloorParkWatch } from './FloorParkWatch.js';

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
/*
 * MEASURED 2026-09-11 (lane F of the horse audit), from `hand_history` per
 * hour over the previous 24 h, tables dealing horse-only hands: healthy hours
 * 65 (04:00 UTC, the night trough) to 1,167; the 2026-09-10 21:00-00:00 UTC
 * collapse 47, 17, 10 tables dealing while horse hands/hour fell 33,343 -> 546.
 * This floor never fired through that evening (two fires at 23:46-23:50 when
 * the count touched 2). It is deliberately NOT raised here: below it the
 * deal-rate verdict is skipped and /health's restart signal with it, so a
 * higher value would trade a restart for an alert on a 12-table fleet
 * (DealRateVerifier.test.ts "reports its evidence"). The fleet-size page
 * lives where a threshold belongs (CLAUDE.md 10.84): `HorseFleetCollapsed`
 * in `infra/monitoring/alert-rules.yml` reads `poker_dealable_tables < 20`.
 */
const FLEET_FLOOR_TABLES = 3;
/**
 * How stale the horse fleet's own pulse may be before it is a page. Measured
 * 2026-09-11 over 24 h of `ca_horse_fleet_heartbeat`: gap p50 30 s, p95 51 s,
 * the hourly break 447-632 s (skipped here anyway, this check sits behind the
 * freeze guard), and one genuine 2,461 s stall. See checkFleetLoopPulse.
 */
const FLEET_PULSE_STALE_SECONDS = 900;
/** Consecutive minute checks above it before the page. */
const CONSECUTIVE_PULSE_STALE = 2;
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
/** Rows read back to name a storm's causes; a storm larger than this is named from a sample. */
const KILL_BREAKDOWN_ROWS = 2_000;
/**
 * Kills whose first and last fall inside this span are ONE BURST: one cause
 * hit many tables at once, not a loop. The 13:27:10Z storm of 2026-10-25 put
 * 41 kills inside 138 ms; a loop spreads its kills across the window.
 */
const KILL_BURST_SPAN_MS = 60_000;

const COMPONENT = 'club-arena-engine';

/** What a storm's kill rows say, read back so the page can say it. */
export interface KillBreakdown {
  kills: number;
  tables: number;
  /** Top causes, most frequent first (phase or stage, elapsed suffix stripped). */
  causes: Array<[string, number]>;
  /** Every kill inside KILL_BURST_SPAN_MS: one cause hit many tables at once. */
  burst: boolean;
  firstAt: string | null;
  spanMs: number | null;
  /** Tournaments the killed tables belonged to, most hit first (up to three). */
  tournaments: Array<[string, number]>;
  /** How many distinct tournaments were hit in all (the list above is capped). */
  tournamentCount: number;
  names: Map<string, string>;
}

/**
 * THE PAGE SAYS WHOSE TABLES AND WHETHER IT WAS ONE BURST (2026-10-26).
 *
 * "41 engine kills in 15min on 41 tables, most at tournament_lease_lost -
 * tables are being destroyed and rebuilt in a loop" was true and unhelpful:
 * the kills were one tournament's 41 tables inside 138 ms, so there was no
 * loop, and the event was not named. A reader with the page alone could not
 * tell which event to look at or whether it was still happening. Now: the
 * tournament when the killed tables were all one event's, the moment when the
 * kills were one burst, and "all <cause>" when every kill had the same cause.
 * Pure, so the wording is tested without a database.
 */
export function killStormSummary(
  kills: number,
  windowMinutes: number,
  why: KillBreakdown | null
): string {
  let text = kills + ' engine kills in ' + windowMinutes + 'min';
  if (!why) return text + ' - tables are being destroyed and rebuilt in a loop';
  text += ' on ' + why.tables + ' tables';
  if (why.tournaments.length === 1) {
    const [id] = why.tournaments[0];
    const name = why.names.get(id);
    text += ' of tournament ' + (name ? '"' + name + '" (' + id.slice(0, 8) + ')' : id.slice(0, 8));
  } else if (why.tournaments.length > 1) {
    text += ' across ' + why.tournamentCount + ' tournaments';
  }
  const [topCause, topCount] = why.causes[0];
  text += (topCount >= why.kills ? ', all ' : ', most at ') + topCause;
  if (why.burst && why.firstAt) {
    text += ' - one burst at ' + why.firstAt.slice(11, 19) + 'Z, not a loop';
  } else if (why.spanMs !== null) {
    text +=
      ' - spread over ' +
      Math.max(1, Math.round(why.spanMs / 60_000)) +
      'min, tables are being destroyed and rebuilt in a loop';
  } else {
    text += ' - tables are being destroyed and rebuilt in a loop';
  }
  return text;
}

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
  /**
   * ── THE SEEDING LOOP HAS ITS OWN PULSE, AND NOTHING WATCHED IT ───────────
   *
   * Dan, 2026-09-11: "I SHOULD GET PUSH NOTIFICATIONS OR TEXT IF ANYTHING
   * INSIDE THE HORSES IS FAILING OR THEY CAN'T PLAY."
   *
   * This class already answers "is the fleet above the floor" and "are the
   * dealing tables producing hands". Neither can see the third way the horses
   * stop playing: HorseFleetManager's 30-second cycle simply stopping while
   * the process stays up and the tables that are already seated carry on
   * dealing. Measured on `ca_horse_fleet_heartbeat`, 24 hours to 2026-09-11:
   * beat gap p50 30 s, p95 51 s, the hourly break 447-632 s, and one gap of
   * 2,461 s at 01:33 UTC - 41 minutes in which no horse anywhere could be
   * seated, no alarm fired, and the floor simply drained as sessions ended.
   *
   * `fleetHeartbeatAgeSeconds` returns that age (-1 before the first beat of
   * this process, which is not a fault). Optional, so a caller that has no
   * fleet - a test, a follower instance - is unchanged.
   */
  constructor(
    private readonly dealingTableIds: () => string[],
    private readonly fleetHeartbeatAgeSeconds?: () => number
  ) {}

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
    // The floor-park share this class consults below; see FloorParkWatch.ts.
    startFloorParkWatch();
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
    stopFloorParkWatch();

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
        // Count the thing this alarm names, not every recovery action. Exact
        // positive filters are fail-closed: a new event/class cannot silently
        // become a production kill, and fault-injection drills remain visible
        // in the ledger without paging the real incident channel.
        .eq('event', 'watchdog_kill_rebuild')
        .eq('event_class', 'automatic_recovery')
        .gt('created_at', since);
      if (this.lifecycleEnded(generation)) return;
      if (error) {
        this.killsInWindow = null;
        return;
      }
      const kills = count ?? 0;
      this.killsInWindow = kills;
      if (kills >= KILL_STORM_THRESHOLD) {
        // Best effort: a breakdown that cannot be read never holds the alert.
        const why = await this.killBreakdown(since);
        if (this.lifecycleEnded(generation)) return;
        this.launchAlert(
          raiseEngineAlert({
            alertname: 'ClubArenaEngineKillStorm',
            severity: 'critical',
            component: COMPONENT,
            summary: killStormSummary(kills, Math.round(KILL_WINDOW_MS / 60_000), why),
            description:
              'Healthy is under one an hour. ' +
              (why
                ? 'Kills by phase or stage: ' +
                  why.causes.map(([cause, n]) => cause + ' x' + n).join(', ') +
                  '. ' +
                  (why.tournaments.length > 0
                    ? 'Tournaments hit: ' +
                      why.tournaments
                        .map(([id, n]) => (why.names.get(id) ?? id.slice(0, 8)) + ' x' + n)
                        .join(', ') +
                      '. '
                    : '')
                : '') +
              'engine_recovery_events.detail names the phase or stage of every kill.',
            labels: why
              ? {
                  kills: String(kills),
                  tables: String(why.tables),
                  top_cause: why.causes[0][0],
                  shape: why.burst ? 'burst' : 'spread',
                  ...(why.tournaments.length === 1 ? { tournament_id: why.tournaments[0][0] } : {}),
                }
              : { kills: String(kills) },
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
   * WHAT THE KILLS WERE, so the page says it (2026-10-17).
   *
   * The 12:57Z storm paged "74 engine kills in 15min" and nothing else; the
   * reason - 74 x `start_failed:start_load_table` on 42 tables - had to be read
   * out of the database by hand. Every kill row already names its phase or
   * stage, so this reads them back (bounded) and returns how many tables were
   * hit and the top causes, most frequent first. Read-only, and null when it
   * cannot be read: the alert is raised either way.
   */
  private async killBreakdown(since: string): Promise<KillBreakdown | null> {
    try {
      const { data, error } = await supabase
        .from('engine_recovery_events')
        .select('detail, table_id, created_at')
        .eq('event', 'watchdog_kill_rebuild')
        .eq('event_class', 'automatic_recovery')
        .gt('created_at', since)
        .limit(KILL_BREAKDOWN_ROWS);
      if (error || !Array.isArray(data) || data.length === 0) return null;
      const tables = new Set<string>();
      const causes = new Map<string, number>();
      let firstAt = Number.POSITIVE_INFINITY;
      let lastAt = Number.NEGATIVE_INFINITY;
      for (const row of data as Array<{
        detail?: unknown;
        table_id?: unknown;
        created_at?: unknown;
      }>) {
        if (row.table_id) tables.add(String(row.table_id));
        // `dealing_loop_died+96s` and `start_failed:start_crash_recovery` keep
        // their cause; the elapsed suffix would split one cause into many.
        const cause =
          String(row.detail ?? 'unnamed')
            .split('+')[0]
            .trim() || 'unnamed';
        causes.set(cause, (causes.get(cause) ?? 0) + 1);
        const at = Date.parse(String(row.created_at ?? ''));
        if (Number.isFinite(at)) {
          if (at < firstAt) firstAt = at;
          if (at > lastAt) lastAt = at;
        }
      }
      const timed = Number.isFinite(firstAt) && Number.isFinite(lastAt);
      // Best effort, like the breakdown itself: a tournament that cannot be
      // named leaves the page exactly as it was without this read.
      const hit = await this.killedTournaments([...tables]);
      return {
        kills: data.length,
        tables: tables.size,
        causes: [...causes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
        burst: timed && lastAt - firstAt <= KILL_BURST_SPAN_MS,
        firstAt: timed ? new Date(firstAt).toISOString() : null,
        spanMs: timed ? lastAt - firstAt : null,
        ...hit,
      };
    } catch {
      return null;
    }
  }

  /**
   * WHICH TOURNAMENT THE KILLED TABLES BELONGED TO (2026-10-26).
   *
   * The 13:27:10Z storm paged "41 engine kills in 15min on 41 tables, most at
   * tournament_lease_lost": 41 tables, one tournament, one lost lease, and the
   * page did not say which event. Every killed table row names its tournament,
   * so this reads them back (bounded) and counts kills per tournament, most
   * hit first, with each one's name. Read-only, best effort: on any failure it
   * returns no tournaments and the page is raised as before.
   */
  private async killedTournaments(
    tableIds: string[]
  ): Promise<Pick<KillBreakdown, 'tournaments' | 'tournamentCount' | 'names'>> {
    const none = {
      tournaments: [] as Array<[string, number]>,
      tournamentCount: 0,
      names: new Map<string, string>(),
    };
    if (tableIds.length === 0) return none;
    try {
      const byTournament = new Map<string, number>();
      for (let i = 0; i < tableIds.length; i += IN_LIST_CHUNK) {
        const { data, error } = await supabase
          .from('tables')
          .select('id, tournament_id')
          .in('id', tableIds.slice(i, i + IN_LIST_CHUNK));
        if (error || !Array.isArray(data)) return none;
        for (const row of data as Array<{ tournament_id?: unknown }>) {
          if (!row.tournament_id) continue;
          const id = String(row.tournament_id);
          byTournament.set(id, (byTournament.get(id) ?? 0) + 1);
        }
      }
      const tournaments = [...byTournament.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      const names = new Map<string, string>();
      // A name that cannot be read costs the name, never the count: the id
      // still says which event.
      if (tournaments.length > 0) {
        try {
          const { data, error } = await supabase
            .from('tournaments')
            .select('id, name')
            .in(
              'id',
              tournaments.map(([id]) => id)
            );
          if (!error && Array.isArray(data)) {
            for (const row of data as Array<{ id?: unknown; name?: unknown }>) {
              if (row.id && typeof row.name === 'string' && row.name.trim()) {
                names.set(String(row.id), row.name.trim());
              }
            }
          }
        } catch {
          // names stay empty
        }
      }
      return { tournaments, tournamentCount: byTournament.size, names };
    } catch {
      return none;
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
  /** Consecutive checks whose fleet pulse was stale. See checkFleetLoopPulse. */
  private fleetLoopStalledChecks = 0;

  /**
   * THE SEEDING LOOP IS ALIVE, OR DAN'S PHONE SAYS SO.
   *
   * Threshold measured, not guessed (CLAUDE.md 10.84). A beat is written on
   * every completed cycle: p50 30 s, p95 51 s, worst ordinary gap 632 s
   * (the hourly break, which this check is behind the freeze guard for).
   * `FLEET_PULSE_STALE_SECONDS` sits above all of them and below the only
   * real outage in the day's data (2,461 s), and two consecutive minute
   * checks are required so a slow cycle on a saturated database - the 118 s
   * worst case this file's own history records - can never page.
   *
   * Fires once, resolves once, through the same `raiseEngineAlert` state the
   * other two criticals use. `page: true`, because a fleet that cannot seat
   * anybody is exactly the thing Dan asked to be told about.
   */
  private checkFleetLoopPulse(): void {
    if (!this.fleetHeartbeatAgeSeconds) return;
    let age: number;
    try {
      age = this.fleetHeartbeatAgeSeconds();
    } catch {
      return; // A reader that throws is not evidence of a stopped fleet.
    }
    // -1 is "this process has not completed its first cycle yet", which a
    // boot legitimately shows for up to a couple of minutes.
    if (!Number.isFinite(age) || age < 0) {
      this.fleetLoopStalledChecks = 0;
      return;
    }
    if (age <= FLEET_PULSE_STALE_SECONDS) {
      // A previous process can have a persisted firing episode even though
      // this process has no stalled checks. The journal owns recovery dedupe.
      this.launchAlert(
        resolveEngineAlert(
          'ClubArenaHorseFleetLoopStopped',
          COMPONENT,
          'The horse fleet seeding cycle is beating again'
        ),
        'DealRateVerifier.fleet_pulse_resolve_failed'
      );
      this.fleetLoopStalledChecks = 0;
      return;
    }
    this.fleetLoopStalledChecks++;
    if (this.fleetLoopStalledChecks !== CONSECUTIVE_PULSE_STALE) return;
    this.launchAlert(
      raiseEngineAlert({
        alertname: 'ClubArenaHorseFleetLoopStopped',
        severity: 'critical',
        component: COMPONENT,
        // Preserve urgent incident priority in the Codex investigation task.
        page: true,
        summary: 'The horse fleet has not completed a seeding cycle for ' + Math.round(age) + 's',
        description:
          'HorseFleetManager writes a heartbeat on every completed cycle (about every 30s; ' +
          'p95 51s). It has not completed one for ' +
          Math.round(age) +
          's outside a maintenance break, so no horse is being seated anywhere on the platform - ' +
          'the floor drains as sessions end and nothing refills it. Read the engine log for the ' +
          "cycle's last error, and ca_horse_fleet_heartbeat for the last beat it recorded.",
        labels: { fleet_pulse_seconds: String(Math.round(age)) },
      }),
      'DealRateVerifier.fleet_pulse_raise_failed'
    );
  }

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
        this.fleetLoopStalledChecks = 0;
        this.lastCheckedAt = Date.now();
        return;
      }

      this.checkFleetLoopPulse();

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
        /**
         * AN OWNER FLOOR PARK IS NOT A LOST FLOOR (2026-10-15). On 2026-10-15
         * the owner parked seven clubs that hold every cash table for a horse
         * wallet reset, and this alarm paged at 17:33 for a stop he had
         * scheduled. While a fresh read says a park holds at least half the
         * floor, the floor being below FLEET_FLOOR_TABLES is the park's doing:
         * stand down exactly as for the break, counters reset so a streak
         * gathered under the park cannot fire one tick after it ends. A park
         * that nobody keeps is paged by the floor-hold watchdog instead, and a
         * read that fails says 0 here, so this never hides a real loss for
         * longer than a lease. See FloorParkWatch.ts.
         */
        if (fleetIsParkedByOwner()) {
          this.belowFloorChecks = 0;
          this.silentChecks = 0;
          this.handsInWindow = null;
          this.lastCheckedAt = Date.now();
          return;
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
              // Preserve urgent incident priority in the Codex investigation task.
              page: true,
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
              // Preserve urgent incident priority in the Codex investigation task.
              page: true,
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
