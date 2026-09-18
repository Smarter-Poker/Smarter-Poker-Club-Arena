/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SCHEDULED MAINTENANCE BREAK
 *  Dan, 2026-09-01, binding
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim:
 *
 *   "A SCHEDULED PAUSE (LIKE A TOURNAMENT BREAK) WHERE 2 MIN BEFORE THE
 *   RESTART ALL TABLES FINISH THE HAND THEY ARE ON, AS WE ARE DOING AN ENGINE
 *   RESTART, ALL GAMES ARE THEN PAUSED (NOTHING IS LOST OR CORRUPTED) HANDS
 *   FINISH, ENGINE RESTARTS AS SCHEDULED AND THE HANDS PICK RIGHT BACK UP AS
 *   SOON AS THE RESTART IS OVER. (A 5 MINUTE BREAK IS ANNOUNCED) AND ALL
 *   HANDS RESUME THEN."
 *
 * ─── WHAT THIS REPLACES ────────────────────────────────────────────────────
 *
 * A restart costs roughly three minutes end to end: up to 45s of `docker stop`
 * grace, up to 90s of container health-start, and ~2 minutes during which
 * every table answers 4404 while engines are rebuilt from snapshots. Before
 * today the platform simply ATE that, five times a day, with no warning to
 * anybody: cards vanished, the felt went dead, and a player who reloaded got
 * "This Table Is No Longer Running" for a table that was fine.
 *
 * Nothing here makes the restart faster. It makes the restart INVISIBLE, by
 * putting the whole outage inside a break players were told about, on tables
 * that had already finished their hands and had no cards in the air.
 *
 * ─── THE TIMELINE ──────────────────────────────────────────────────────────
 *
 *   :53   announceLastHand()
 *         Every engine gets pauseForMaintenance(budget).
 *         The hand in front of a player plays to the end. No new hand starts.
 *         Players see "Last Hand - Maintenance Break In 2:00".
 *
 *   :55   beginCountdown()
 *         Every table is parked. The 5:00 countdown players see starts HERE,
 *         not at :53 - a player must never watch a clock that was already
 *         running before they were told about it. The break is written to
 *         `engine_maintenance_break`, and /health starts reporting
 *         readyForRestart, which is the deploy workflow's cue.
 *
 *   ~:55  SIGTERM. drainHands() finds every table already parked, so it
 *         returns immediately instead of burning its 18s budget, and
 *         GameServer.stop() flushes state against a platform that is standing
 *         completely still.
 *
 *   ~:58  The new engine boots, reads the row, and re-parks every table it
 *         rebuilds until break_ends_at. This is the part that cannot be done
 *         in memory and is the entire reason the break is persisted.
 *
 *   :00   end(). The clocks are thawed, then every engine resumes on the
 *         hour - in waves across the first ~10s, see RESUME_WAVES.
 *
 * ─── WHY :55, AND WHY EVERY HOUR ───────────────────────────────────────────
 *
 * Tournaments already take a synchronized five-minute break at :55 (see
 * GameServer.scheduleSynchronizedBreaks). The restart moves onto it rather
 * than inventing a second, competing break: an MTT must never be stopped twice
 * in one hour, and at :55 its blind clock is already suspended by
 * TournamentManagerBase.pauseForBreak, so levels cannot tick through a
 * restart. Aligning also fixes an old wart for free - because this module has
 * every table parked by :55, the tournament break's `waitForAllTablesParked`
 * succeeds instantly instead of burning its two-minute grace, so tournament
 * breaks now genuinely run :55 to :00 rather than :57 to :02.
 *
 * EVERY HOUR, NOT FIVE TIMES A DAY (Dan, 2026-09-01):
 *
 *   "program the engine restart to be every hour on the :55 instead of every
 *   5 hours so nothing gets lost or orphaned from production improvements."
 *
 * The five-window schedule existed because a restart was expensive and
 * visible, so it was rationed - and the cost of rationing it was that merged
 * engine code sat unshipped for up to six hours, which is how fixes get
 * orphaned and how two agents end up reasoning about different production
 * builds. Now that the restart happens inside a break nobody loses a hand to,
 * the reason to ration it is gone.
 *
 * An hourly WINDOW is not an hourly restart. The deploy dedupes on the served
 * commit, so a window with no new code costs one HTTP request and nothing
 * else. The engine only actually bounces when there is something to ship, and
 * then it does so within the hour.
 *
 * The break itself DOES run every hour regardless, and that is deliberate:
 * tournaments already break hourly, so this simply brings cash tables onto the
 * same rhythm. Dan, 2026-08-27: "EVERY HORSE OR HUMAN PLAYER NEEDS TO BE
 * TREATED 100% EXACTLY THE SAME ALL ACROSS THE BOARD" - and a fleet where the
 * MTTs stop on the hour while the cash games roll on is the same tell one
 * level up. A predictable five minutes at the top of every hour is also the
 * thing that makes the restart unremarkable when it does happen.
 *
 * ─── HORSES ARE PLAYERS (CLAUDE.md 10.5) ───────────────────────────────────
 *
 * There is no `is_horse` anywhere in this file and there must never be one.
 * Every engine in the fleet is parked, announced to and resumed identically.
 * Dan: "TIMING IS PART OF THE TREATMENT" - a table that stopped for the break
 * while the one beside it played on would tell every watching player which
 * seats are horses.
 */

import { randomUUID } from 'node:crypto';
import { completeReconnectFreeze, completeTableReconnectFreeze } from './reconnectFreeze.js';
import { setMaintenanceFrozen } from './freezeState.js';
import {
  assertMaintenanceThawRelease,
  MaintenanceThawError,
  waitForMaintenanceThaw,
  type MaintenanceThawRequest,
  type MaintenanceThawRelease,
} from './maintenanceThawV3.js';

/**
 * The parking primitive, as this module needs it.
 *
 * `pauseForMaintenance` / `resumeFromMaintenance` rather than the
 * hand-for-hand pair, because the two are independent authorities and
 * hand-for-hand's 500ms sync loop would otherwise resume a table mid-break.
 * See the `maintenancePaused` field on ServerTableEngineBase.
 */
export interface PausableTableEngine {
  pauseForMaintenance(maxWaitMs: number): void;
  resumeFromMaintenance(): void;
  /** Parked between hands, from EITHER loop - dealing or start-up wait. */
  isParkedBetweenHands(): boolean;
  /**
   * No cards in the air: `handController === null`, which the engine only
   * sets AFTER the hand-complete listener has settled the pot. This is what
   * the restart gate asks (PHASE 2, 2026-09-02) - see `unparkedTables`.
   */
  isBetweenHands(): boolean;
  /** Positive original preparation disposition must survive process replacement. */
  hasUnresolvedF06Preparation?(): boolean;
  /** Initialized time banks have reached the durable park row. */
  isMaintenanceStateDurable?(): boolean;
  /**
   * Which durability condition is false, or null when none is. Optional: an
   * engine that does not answer is reported under `unknown` rather than
   * silently folded into the total.
   */
  maintenanceDurabilityReason?(): string | null;
  isRunning(): boolean;
  /**
   * Cash or tournament. Optional: an engine that does not say is treated as
   * cash. Read ONLY to interleave the two kinds across the resume waves
   * (2026-09-05) so that no wave is 90 tournament tables and the next 90
   * cash tables - never to give either kind a different deal.
   */
  isTournament?(): boolean;
}

export type MaintenanceBreakPhase = 'last_hand' | 'counting_down';
export type MaintenancePresentationPhase =
  | MaintenanceBreakPhase
  | 'finalizing'
  | 'resuming'
  | 'idle';

export interface PersistedMaintenanceBreak {
  phase: MaintenanceBreakPhase;
  announcedAt: number;
  /**
   * When the countdown actually began. The thaw needs the real instant, not a
   * derived one: deadlines are shifted by (end - start), and a start
   * reconstructed as breakEndsAt minus five minutes would misstate the frozen
   * duration for any break that was adopted mid-way by a fresh engine.
   */
  breakStartedAt: number | null;
  breakEndsAt: number | null;
  reason: string;
  /** Opaque writer generation; rotated atomically whenever a process adopts. */
  ownershipToken: string;
}

/** Durable side, so the tests can drive this without a database. */
export interface MaintenanceBreakStore {
  load(): Promise<PersistedMaintenanceBreak | null>;
  save(state: PersistedMaintenanceBreak): Promise<void>;
  /** Atomically replace an observed owner's token and return the current row. */
  claim(
    expectedOwnershipToken: string,
    newOwnershipToken: string
  ): Promise<PersistedMaintenanceBreak | null>;
  /** Compare-and-delete only the exact state and writer generation this process owns. */
  clear(expected: PersistedMaintenanceBreak): Promise<void>;
  /** Null only after the database's completed-v3 release boundary expires. */
  loadReleaseBoundary(): Promise<number | null>;
}

/**
 * What one break measured about itself, handed out at `end()` so the
 * scorecard (ca_break_scorecards, phase 1) can show the gate's own numbers
 * rather than only what hand_history reveals from the outside.
 */
export interface MaintenanceBreakOutcome {
  breakStartedAtMs: number;
  breakEndedAtMs: number;
  /** Tables with a hand in flight the instant the countdown began. */
  unparkedAtCountdown: number;
  /** Highest unparked count observed at any sample during the countdown. */
  peakUnparked: number;
  /** First instant readyForRestart() answered true, or null if it never did. */
  readyForRestartAtMs: number | null;
  tablesResumed: number;
  thawOk: boolean | null;
}

/**
 * Why a break did not run the way it was announced (2026-09-10).
 *
 * The 00:00 and 07:00 breaks of 2026-09-10 never started: the :53 save timed
 * out behind an entry, one timeout cancelled the whole hour, and the tables
 * dealt 750 and 2476 hands through the window. The only record of WHY was a
 * container log that the next deploy deleted; the scorecard, twelve minutes
 * later, could only list consequences ("it dealt hands", "the thaw did not
 * run"). This is the durable half of that sentence.
 */
export interface MaintenanceBreakFault {
  /** The :53 announcement instant that names the hour's break. */
  announcedAtMs: number;
  /** Which durable write could not be made. */
  stage: 'announcement' | 'countdown' | 'adoption' | 'boot';
  /**
   * `cancelled`: no break ran, and the fleet dealt through the window.
   * `held_without_restart`: the break ran to the hour on a row that was
   * already durable, but carried no restart certificate.
   */
  outcome: 'cancelled' | 'held_without_restart';
  error: string;
}

/** /health: `maintenance.resumeWaves`. Null when no rollout has run since the last announcement. */
export interface ResumeWavesProgress {
  /** Waves in this rollout. */
  total: number;
  /** Waves fired so far (wave 0 counts as soon as end() has run it). */
  done: number;
  /** Epoch ms when wave 0 fired. */
  startedAt: number;
  /** Epoch ms when the last wave fired, or null while waves are still due. */
  finishedAt: number | null;
  /** Tables in the rollout, and how many have received their resume. */
  tables: number;
  tablesResumed: number;
  gapMs: number;
}

export interface MaintenanceBreakDeps {
  /** Every live table engine, cash and tournament alike. */
  engines(): Iterable<[string, PausableTableEngine]>;
  /** False once the process is shutting down; stops any further scheduling. */
  isRunning(): boolean;
  /** Discrete per-table event frame to every subscriber of that table. */
  emit(tableId: string, payload: Record<string, unknown>): void;
  /** Presentation only, emitted at the owning transition to existing lobby subscribers. */
  emitPresentation?: (presentation: Record<string, unknown>) => void;
  store: MaintenanceBreakStore;
  /** Fail closed until the database protects event-owned recovery windows from DDL. */
  assertRecoveryWindowContract?: () => Promise<void>;
  /**
   * "Is somebody ELSE still holding this table paused?"
   *
   * The maintenance break resumes every table when it ends, and that is right
   * for the fleet but wrong for a table another authority is also holding. A
   * tournament add-on break runs up to ten minutes, so one that begins near
   * :55 outlives the five-minute maintenance break; resuming it here would
   * deal that tournament back into play while its own clock still has it away.
   * Optional, and defaults to "nobody else is holding anything".
   */
  shouldStayPaused?: (tableId: string) => boolean;
  /**
   * Receives the break's own measurements at `end()`. Optional; failures
   * are reported and never delay the resume.
   */
  recordOutcome?: (outcome: MaintenanceBreakOutcome) => Promise<void>;
  /**
   * Receives the reason a break did not run as announced, so the scorecard can
   * name the CAUSE rather than its symptoms. Optional and best-effort: it is
   * called after the decision is taken and never delays or changes it.
   */
  recordFault?: (fault: MaintenanceBreakFault) => Promise<void>;
  /**
   * THE THAW (Dan 2026-09-01: "picks back up exactly as it was").
   *
   * Called once, at the end of the break, BEFORE the first table resumes.
   * Wired to fn_thaw_platform, which shifts every in-flight absolute deadline
   * - sit-out clocks, seat holds, add-on windows, Spin level clocks, the
   * cashier claim-back window - forward by the frozen duration, so no
   * player-facing clock lost time to a break they could not play through.
   * Idempotent on the server side (keyed on the freeze start instant), so two
   * engines racing at :00 cannot shift the clocks twice.
   */
  thaw?: (
    request: Readonly<MaintenanceThawRequest>,
    signal: AbortSignal
  ) => Promise<MaintenanceThawRelease>;
  /** Injectable purely so the tests are not real-time. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (t: NodeJS.Timeout) => void;
  /** Engine build, recorded on the row for post-mortems. */
  version?: string;
}

export class MaintenanceBreak {
  /** The break itself, matching the tournament synchronized break exactly. */
  static readonly BREAK_DURATION_MS = 5 * 60 * 1000;

  /** The countdown starts at :55, so the announcement lands at :53. */
  static readonly BREAK_START_MINUTE = 55;
  static readonly LAST_HAND_LEAD_MS = 2 * 60 * 1000;

  /**
   * How old a persisted break row may be and still be adopted by a booting
   * engine (2026-09-07).
   *
   * The whole legitimate span is the announcement lead plus the break itself —
   * an engine that boots at :58 is adopting a row announced at :53, five
   * minutes earlier. A minute of slack covers a slow boot and a clock skew.
   * Anything older belongs to an hour that has already finished, and adopting
   * it parks the entire fleet for a break nobody announced. Before this
   * existed, `restoreFromStore` computed a full five minutes for any
   * `last_hand` row regardless of age, so its staleness check could never
   * fire and an orphaned row was a fleet-wide freeze waiting for the next
   * boot.
   */
  static readonly ADOPTABLE_ROW_MAX_AGE_MS =
    MaintenanceBreak.LAST_HAND_LEAD_MS + MaintenanceBreak.BREAK_DURATION_MS + 60_000;

  /**
   * How long a table is allowed to stay parked before `awaitPauseGate`'s
   * safety timeout resumes it anyway.
   *
   * Must cover the whole worst case - the two-minute last-hand wait plus the
   * full five-minute break - or tables self-resume and deal into the break,
   * which is the exact bug Dan hit at the :55 tournament break on 2026-08-19.
   * One minute of slack on top, and still comfortably under
   * GameServer.MAX_HEALTHY_PAUSE_MS (10 min), so the stall reapers never
   * mistake a legitimate break for a wedged table.
   */
  static readonly PARK_BUDGET_MS =
    MaintenanceBreak.LAST_HAND_LEAD_MS + MaintenanceBreak.BREAK_DURATION_MS + 60_000;

  /**
   * The deploy workflow may only START a restart while at least this much
   * break remains. A restart takes ~3 minutes; beginning one with 40 seconds
   * left would put the rehydration outage OUTSIDE the announced break, which
   * is the whole thing this exists to prevent. Late is not better than never
   * here - the next window is six hours away and the platform is fine.
   */
  static readonly MIN_REMAINING_FOR_RESTART_MS = 3 * 60 * 1000;

  /**
   * THE RESUME ARRIVES IN INSTALLMENTS (2026-09-05; supersedes the phase 3
   * 25-per-750ms stagger of 2026-09-02).
   *
   * The engine is ONE core, and horse Monte Carlo was 90% of it when it was
   * profiled (EquityLoadGovernor.ts). At 04:00 UTC on 2026-09-05 the break
   * ended with 318 cash and 402 tournament tables parked; the core went from
   * 8% to saturated inside thirty seconds of :00 and stayed there, /health
   * stopped answering, and the container was replaced at 04:07 (instance
   * 1-40d0cff4 -> 1-c3b8997e, same build, MemAvailable +700MB the moment
   * the process died). The DATABASE thaw (fn_thaw_platform, phase 4) is
   * already in installments and was fine; the ENGINE side still woke the
   * fleet in a fixed 25-table batch every 750ms, in Map insertion order -
   * which after a restart is adoption order, tournaments first.
   *
   * Now the fleet is dealt into RESUME_WAVES waves, each about
   * ceil(total / RESUME_WAVES) tables, RESUME_WAVE_GAP_MS apart. The whole
   * spread is (RESUME_WAVES - 1) * RESUME_WAVE_GAP_MS = 10.5s, well inside
   * the :00 minute. Wave 0 fires synchronously inside end().
   *
   * "TOGETHER" (CLAUDE.md 13: "every table resumes together at :00") is read
   * as "within the same few seconds of the same minute", not "in the same
   * event-loop tick". The same-tick reading is what saturated the core; the
   * clocks are unaffected either way because fn_thaw_platform shifted every
   * deadline by the frozen duration BEFORE wave 0, so a table woken in wave
   * 7 has lost nothing it could be judged on (see resumeEveryEngine).
   *
   * ORDER. Within each kind (cash, tournament) tables are sorted by a stable
   * hash of the table id, and the two kinds are dealt round-robin into the
   * waves, so every wave carries its share of each. The hash makes the order
   * independent of adoption order and of anything about who is seated.
   * "Humans first" was considered and REJECTED under CLAUDE.md 10.5: ordering
   * a queue by is_horse gives a horse-only table a later wake, and a
   * spectator watching two tables would learn which one is horses from
   * which came back first - the same tell 10.5 names for the rebuy pause,
   * and the same shape as the humansSeatedTotal drain gate Dan had replaced
   * with handsInFlightTotal. Timing is part of the treatment.
   *
   * A wave never carries fewer than RESUME_WAVE_MIN_TABLES, so a small
   * fleet (and every test fleet) is fully up before end() returns, exactly
   * as under phase 3. tests/the-break-clocks-agree.law.test.ts pins the
   * spread; MaintenanceBreak.test.ts pins the order, the gap, the /health
   * block and that one throwing table never holds a wave.
   */
  static readonly RESUME_WAVES = 8;
  static readonly RESUME_WAVE_GAP_MS = 1500;
  static readonly RESUME_WAVE_MIN_TABLES = 25;
  /** The whole rollout, first wave to last, for the law pin and /health. */
  static readonly RESUME_SPREAD_MS =
    (MaintenanceBreak.RESUME_WAVES - 1) * MaintenanceBreak.RESUME_WAVE_GAP_MS;

  private phase: MaintenanceBreakPhase | 'idle' = 'idle';
  private announcedAt = 0;
  /** When counting_down began - the instant the thaw measures from. */
  private breakStartedAt = 0;
  /** PHASE 2 measurements, reset at beginCountdown, handed out at end(). */
  private unparkedAtCountdown = 0;
  private peakUnparked = 0;
  private readyForRestartAtMs: number | null = null;
  /**
   * True only when the exact in-memory phase/timestamps/token have either
   * committed or been recovered by a byte-for-byte read-back.  Kept separate
   * from `readyForRestart`: parking every table is necessary, but it is not
   * proof that a replacement process can recover the same break.
   *
   * This additive field is the rolling-upgrade bridge for the stricter deploy
   * gate.  Older deploy code ignores it; newer deploy code refuses to replace
   * this process unless it is exactly true.
   */
  private durableConfirmed = false;
  /**
   * The last exact state this process knows the database holds: a save that
   * returned, a read-back that matched, or an adoption receipt. The end of a
   * break clears it as well as the final state, because a countdown that could
   * not be saved leaves the LAST-HAND row in place - and that row keeps every
   * entry door frozen until it is deleted (fn_entry_purchases_frozen has no
   * end time for it).
   */
  private lastDurableState: PersistedMaintenanceBreak | null = null;
  /** Bumped each break; a scheduled resume wave from a superseded break is dropped. */
  private resumeToken = 0;
  /**
   * The rollout in progress (or the last one, until the next break is
   * announced), published on /health as `maintenance.resumeWaves` so a
   * :00:05 curl can say which wave the fleet is on.
   */
  private resumeWaves: ResumeWavesProgress | null = null;
  private breakEndsAt = 0;
  // Presentation never changes persisted identity, thaw credits or restart gates.
  private certifiedResumeAt = 0;
  private completedAnnouncementAt = 0;
  private pendingResumeTables = new Set<string>();
  private reason = 'Scheduled Engine Maintenance';
  private ownershipToken: string = randomUUID();

  private announceTimer: NodeJS.Timeout | null = null;
  private countdownTimer: NodeJS.Timeout | null = null;
  private endTimer: NodeJS.Timeout | null = null;
  private resumeWaveTimers = new Set<NodeJS.Timeout>();
  private lifecycleJobs = new Set<Promise<void>>();
  private lifecycleGeneration = 0;
  private acceptingLifecycleWork = true;
  private startOperation: Promise<void> | null = null;
  private stopOperation: Promise<void> | null = null;
  private started = false;
  private readonly lifecycleAbort = new AbortController();
  private releaseBoundaryOnly = false;
  private thawRequest: Readonly<MaintenanceThawRequest> | null = null;
  private recoveryReadPending = false;
  static readonly THAW_RETRY_MS = 5_000;

  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (t: NodeJS.Timeout) => void;

  constructor(private readonly deps: MaintenanceBreakDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Arm the schedule, and adopt a break that was already running when this
   * process started. Boot recovery comes FIRST: the common case for a fresh
   * engine is that it is booting *because* of the restart this break was
   * declared for, and it must not deal a single hand before it knows that.
   */
  start(): Promise<void> {
    if (this.stopOperation) {
      return Promise.reject(new Error('A stopped MaintenanceBreak instance cannot be restarted'));
    }
    if (this.startOperation) return this.startOperation;
    this.started = true;
    this.acceptingLifecycleWork = true;
    const generation = ++this.lifecycleGeneration;
    this.startOperation = this.performStart(generation);
    return this.startOperation;
  }

  private async performStart(generation: number): Promise<void> {
    await this.restoreFromStore(generation);
    if (!this.lifecycleIsCurrent(generation)) return;
    this.scheduleNextAnnouncement();
  }

  stop(): Promise<void> {
    if (this.stopOperation) return this.stopOperation;
    this.started = false;
    this.acceptingLifecycleWork = false;
    this.lifecycleAbort.abort(new Error('Maintenance break lifecycle stopped'));
    this.lifecycleGeneration += 1;
    this.resumeToken += 1;
    for (const t of [this.announceTimer, this.countdownTimer, this.endTimer]) {
      if (t) this.clearTimer(t);
    }
    for (const timer of this.resumeWaveTimers) this.clearTimer(timer);
    this.resumeWaveTimers.clear();
    this.announceTimer = null;
    this.countdownTimer = null;
    this.endTimer = null;
    this.stopOperation = this.performStop();
    return this.stopOperation;
  }

  private async performStop(): Promise<void> {
    if (this.startOperation) await this.startOperation.catch(() => undefined);
    // A starter that crossed its final await before seeing the generation
    // fence may have armed a timer. Clear the sources once more after join.
    for (const t of [this.announceTimer, this.countdownTimer, this.endTimer]) {
      if (t) this.clearTimer(t);
    }
    for (const timer of this.resumeWaveTimers) this.clearTimer(timer);
    this.resumeWaveTimers.clear();
    this.announceTimer = null;
    this.countdownTimer = null;
    this.endTimer = null;
    while (this.lifecycleJobs.size > 0) {
      await Promise.allSettled([...this.lifecycleJobs]);
    }
  }

  private lifecycleIsCurrent(generation: number): boolean {
    return this.acceptingLifecycleWork && this.lifecycleGeneration === generation;
  }

  private launchLifecycleJob(operation: Promise<unknown>, context: string): void {
    let tracked!: Promise<void>;
    tracked = operation
      .then(() => undefined)
      .catch((error) => console.error(`[MaintenanceBreak] ${context}`, error))
      .finally(() => this.lifecycleJobs.delete(tracked));
    this.lifecycleJobs.add(tracked);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Boot recovery - the reason any of this is written down
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Re-adopt a break declared by the process we just replaced.
   *
   * Without this the new engine rehydrates its tables and deals immediately,
   * while every player is still watching a countdown with two minutes left on
   * it. The felt would come back to life underneath a break screen - cards
   * dealt to players who are not looking, blinds posted by people who were
   * told they had time.
   *
   * A `last_hand` row is upgraded straight to a full countdown rather than
   * resumed: it means the old engine was killed between the announcement and
   * :55, so the tables never got their five minutes and the players were
   * promised one.
   */
  /**
   * How many times the boot-time read of the break row is attempted before
   * the engine gives up and starts unpaused. The common reason this read
   * fails is the reason it matters most: the engine is booting at ~:55-:58,
   * inside the break, when the database is at its slowest, and a single
   * timed-out read used to mean the fleet came back dealing into a break
   * every screen was still showing. Three tries, a second and a half apart,
   * cost at most ~3s of a boot that is parked anyway if the row exists.
   */
  static readonly RESTORE_ATTEMPTS = 3;
  static readonly RESTORE_RETRY_MS = 1500;

  /**
   * The longest freeze `fn_thaw_platform` will accept. Its own guard reads
   * `p_frozen_seconds > 900 -> implausible_frozen_seconds`, on the reasoning
   * that shifting every deadline on the platform by a wrong number is strictly
   * worse than shifting by nothing. Checked here too so the refusal is a
   * legible log line rather than a silent `ok: false` nobody reads.
   */
  static readonly MAX_THAWABLE_SECONDS = 900;

  /**
   * Rotate a persisted row to this exact process generation.
   *
   * A lost HTTP response may hide a committed token rotation, just as it may
   * hide a committed save. Recover that ambiguity with one exact read-back:
   * only the requested new token plus byte-for-byte unchanged semantic state
   * proves this process owns the row. Anything else fails closed.
   */
  private async claimPersistedState(
    saved: PersistedMaintenanceBreak
  ): Promise<PersistedMaintenanceBreak | null> {
    const newOwnershipToken = randomUUID();
    const expected = { ...saved, ownershipToken: newOwnershipToken };
    let claimError: unknown = null;

    try {
      const claimed = await this.deps.store.claim(saved.ownershipToken, newOwnershipToken);
      if (claimed) {
        if (!MaintenanceBreak.samePersistedState(claimed, expected)) {
          throw new Error('maintenance_break_claim_changed_semantic_state');
        }
        this.ownershipToken = claimed.ownershipToken;
        return claimed;
      }
    } catch (error) {
      claimError = error;
    }

    try {
      const stored = await this.deps.store.load();
      if (MaintenanceBreak.samePersistedState(stored, expected)) {
        console.warn(
          '[MaintenanceBreak] ownership-claim response was lost, but exact durable state was verified'
        );
        this.ownershipToken = newOwnershipToken;
        return stored;
      }
    } catch (readError) {
      console.error('[MaintenanceBreak] ownership-claim read-back also failed', readError);
    }

    if (claimError) throw claimError;
    return null;
  }

  /**
   * THE CLOCK IS THE LAST WITNESS (2026-09-08, from the 14:00 and 15:00 breaks
   * that both "did not pass").
   *
   * `restoreFromStore` decided whether this process stood inside a break by
   * reading one row, and when that row was missing or unreadable it returned
   * and the fleet dealt. On 2026-09-08 the deploy cut the engine over INSIDE
   * two consecutive breaks - `engine_leader.acquired_at` 13:55:48 and
   * 14:56:33, both mid-window - and both replacements came up with nothing to
   * read. Play resumed at 13:56:01 and at 14:57, four and three minutes before
   * the hour the countdown on every screen was pointing at. 945 hands went out
   * inside the first one across 111 tables, no thaw ran in either, and
   * `engine_maintenance_break_log` recorded neither break - so the only thing
   * that ever noticed was the scorecard, twelve minutes later.
   *
   * The row was never the only evidence available. CLAUDE.md 13's timeline is
   * fixed and carries no time zone - announce at :53, park at :55, resume at
   * :00 - so a process booting at 14:56:33 can tell from the wall clock alone
   * that it is standing in the middle of a break. `msUntilNextAnnouncement`
   * has always derived the NEXT window this way. This derives the CURRENT one.
   *
   * It returns null everywhere outside [:53, :00), and the window it returns
   * can never be longer than LAST_HAND_LEAD_MS + BREAK_DURATION_MS because
   * both ends are anchored to the CURRENT hour's :53. That is deliberate, and
   * it is why this does not ask for "the next :00": the deleted
   * `nextHourBoundary()` did exactly that and would have parked the whole
   * fleet for sixty minutes on a boot at :00:00.000. A false positive here is
   * a fleet-wide freeze, so the derivation has to have no boundary case at
   * all, and anchoring to the announcement has none.
   */
  private scheduledBreakWindowAt(at: number): { announcedAt: number; endsAt: number } | null {
    const announceMinute =
      MaintenanceBreak.BREAK_START_MINUTE - MaintenanceBreak.LAST_HAND_LEAD_MS / 60000;
    // UTC setters, the same as `msUntilNextAnnouncement` (#4063): in a
    // fractional-hour zone a LOCAL :53 is not the deployment window's :53, and
    // the two derivations of the same timeline must never disagree.
    const announced = new Date(at);
    announced.setUTCMinutes(announceMinute, 0, 0);
    const announcedAt = announced.getTime();
    const endsAt =
      announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS + MaintenanceBreak.BREAK_DURATION_MS;
    if (at < announcedAt || at >= endsAt) return null;
    return { announcedAt, endsAt };
  }

  /**
   * Hold the fleet for the rest of a break the clock says is running, when
   * there was no durable row to adopt.
   *
   * NEVER FAIL OPEN ON THE CLOCK. Failing open on the ROW is still right - see
   * the retry loop in restoreFromStore - because an unreadable database must
   * not become a platform outage. Failing open on the SCHEDULE is what dealt
   * 945 hands under a break screen, and there is no blip to blame for that
   * one: the engine knew what time it was.
   *
   * `breakStartedAt` is `now()`, NOT the scheduled :55, and that is the single
   * place this deliberately differs from the adoption path. An adopted row is
   * evidence that a break was declared and the platform held from :55; a
   * derived break has no such evidence - the engine may simply have been down
   * across the announcement, in which case nothing was ever frozen.
   * `fn_thaw_platform` shifts every in-flight deadline by the duration it is
   * handed, so claiming a freeze that cannot be evidenced would move every
   * clock on the platform on an assumption, on every cold boot inside the
   * window. This claims only what this process actually held. The END is still
   * the scheduled hour, so nothing resumes early either way.
   */
  private async enterBreakFromTheClock(generation: number, because: string): Promise<void> {
    if (this.isActive()) return;
    const window = this.scheduledBreakWindowAt(this.now());
    if (!window) return;
    const remaining = window.endsAt - this.now();
    if (remaining <= 1000) return;

    this.announcedAt = window.announcedAt;
    this.phase = 'counting_down';
    this.breakStartedAt = this.now();
    this.breakEndsAt = window.endsAt;
    this.resumeWaves = null;
    this.certifiedResumeAt = 0;
    this.pendingResumeTables.clear();
    setMaintenanceFrozen(true);

    console.warn(
      `[MaintenanceBreak] ${because}, but the clock says a break is running - ` +
        `parking every table until the hour on the schedule alone. ` +
        `${Math.round(remaining / 1000)}s remaining.`
    );

    this.parkEveryEngine();

    const derived = this.persistedState();
    try {
      await this.persist(derived);
    } catch (error) {
      /* The same call announceLastHand makes, for the same reason: a break
         nobody else can see is worse than no break, because the database half
         stays disarmed - fn_platform_frozen reads this row - while the engine
         half holds. Resume, and let the next hour try. (beginCountdown no
         longer cancels: by :55 the last-hand row IS the database half.) */
      console.error(
        '[MaintenanceBreak] could not durably declare the clock-derived break; cancelling it',
        error
      );
      await this.cancelBreakAfterPersistenceFailure(false, derived);
      this.reportFault('boot', 'cancelled', error, derived.announcedAt);
      return;
    }
    if (!this.lifecycleIsCurrent(generation)) return;

    this.broadcast('counting_down');
    this.armEndTimer();
  }

  private async restoreFromStore(generation: number): Promise<void> {
    let saved: PersistedMaintenanceBreak | null = null;
    let lastErr: unknown = null;
    let loaded = false;
    for (let attempt = 1; attempt <= MaintenanceBreak.RESTORE_ATTEMPTS && !loaded; attempt++) {
      try {
        saved = await this.deps.store.load();
        if (!this.lifecycleIsCurrent(generation)) return;
        loaded = true;
      } catch (err) {
        lastErr = err;
        if (attempt < MaintenanceBreak.RESTORE_ATTEMPTS) {
          console.warn(
            `[MaintenanceBreak] could not read the persisted break (attempt ${attempt}/${
              MaintenanceBreak.RESTORE_ATTEMPTS
            }), retrying: ${(err as Error)?.message ?? err}`
          );
          await new Promise<void>((r) => this.setTimer(r, MaintenanceBreak.RESTORE_RETRY_MS));
          if (!this.lifecycleIsCurrent(generation)) return;
        }
      }
    }
    if (!loaded) {
      console.error('[MaintenanceBreak] recovery state unreadable; holding and retrying', lastErr);
      this.holdForRecoveryRead();
      return;
    }
    if (!saved) {
      try {
        const releaseAt = await this.deps.store.loadReleaseBoundary();
        if (!this.lifecycleIsCurrent(generation)) return;
        if (releaseAt !== null) {
          this.holdForReleaseBoundary(releaseAt);
          return;
        }
      } catch (error) {
        console.error('[MaintenanceBreak] release witness unreadable; holding and retrying', error);
        this.holdForRecoveryRead();
        return;
      }
      await this.enterBreakFromTheClock(generation, 'there was no persisted break to adopt');
      return;
    }
    if (!this.lifecycleIsCurrent(generation)) return;

    // ── AN ADOPTED BREAK ENDS ON THE HOUR, NOT ON A BOOT INSTANT ───────────
    // (2026-09-07, from the 18:00 break that "did not pass")
    //
    // A `last_hand` row carries no `breakEndsAt`, so `remaining` fell through
    // to a FULL five minutes and the end was computed as `now() + 5min` —
    // `now()` being the adopting process's boot instant, which has nothing to
    // do with the clock the players are watching. On 2026-09-06 a manual
    // `workflow_dispatch` deploy restarted the engine at 18:53:48, across the
    // :53 announcement instead of inside the :55 countdown, and the break ran
    // 18:53:48 -> 18:58:49: it ended SEVENTY-ONE SECONDS BEFORE THE HOUR the
    // countdown on every screen was pointing at. 366 hands were dealt in the
    // single minute 18:59, which the scorecard then reported as "it dealt 366
    // hands inside the break". The break dealt zero. It simply stopped early.
    //
    // Every other timer in this file is wall-clock anchored — see
    // `msUntilNextAnnouncement`, which is scrupulous about it. This was the
    // one path that was not.
    //
    // ── ANCHOR TO THE ANNOUNCEMENT, NOT TO A CLOCK BOUNDARY (2026-09-07) ────
    //
    // The first version of this fix used "the next :00", and that introduced a
    // WORSE bug than the one it fixed. `nextHourBoundary()` returned the
    // FOLLOWING hour for any boot at exactly :00:00.000, and the staleness
    // guard below admits rows up to eight minutes old — so a sixty-second-wide
    // window sat immediately after the hour in which an adopted break would
    // have parked the entire fleet for SIXTY MINUTES. Nothing would have caught
    // it: `fn_platform_frozen` only arms when `break_ends_at` is inside fifteen
    // minutes, so buy-ins would have flowed while nothing dealt; `fn_thaw_
    // platform` refuses anything over 900s, so every in-flight deadline would
    // have burned; and every fleet alarm is deliberately muted while
    // `poker_maintenance_break_active == 1`.
    //
    // The announcement instant already carries everything needed and has no
    // boundary case at all. §13's timeline is fixed: announce at :53, park at
    // :55, resume at :00. So the end IS `announcedAt + LAST_HAND_LEAD_MS +
    // BREAK_DURATION_MS`, which is the same derivation `recordOutcome` already
    // uses. No hour arithmetic, no DST, no `<=` edge.
    //
    // THE CEILING IS THE WHOLE ANNOUNCE-TO-RESUME SPAN, NOT A BREAK.
    // A first draft clamped to `now + BREAK_DURATION_MS` and reintroduced the
    // early resume it was written to fix: an engine booting at 18:53:48 — the
    // real incident — is BEFORE :55, so five minutes from boot lands at
    // 18:58:48 and the fleet resumes 71 seconds early all over again. Tables
    // are parked from the ANNOUNCEMENT, so a boot in that window legitimately
    // holds for up to seven minutes. The ceiling that is actually true is the
    // full :53 -> :00 span, which also bounds a future-dated `announcedAt`
    // from a skewed clock.
    const isAdoptedLastHand = !(saved.phase === 'counting_down' && saved.breakEndsAt);
    // A `counting_down` row carries the wall-clock end the PREVIOUS engine
    // computed, and that is the instant the countdown on every screen is
    // pointing at, so it is taken as it stands — including the few seconds it
    // usually sits past the hour. Only the `last_hand` path, which has no end
    // of its own and used to invent one out of `now()`, is anchored here.
    const announcedEnd =
      saved.announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS + MaintenanceBreak.BREAK_DURATION_MS;
    const endsAt = isAdoptedLastHand
      ? Math.min(
          announcedEnd,
          this.now() + MaintenanceBreak.LAST_HAND_LEAD_MS + MaintenanceBreak.BREAK_DURATION_MS
        )
      : (saved.breakEndsAt as number);
    const remaining = endsAt - this.now();

    // The current SQL freeze outlives its process and visible countdown.
    // Claim and recover even an expired row; age is never release authority.

    /* Semantic timestamps survive a process replacement and therefore cannot
       distinguish the old cleaner from the new owner. Rotate one opaque token
       under the database's exclusive maintenance boundary before parking or
       broadcasting anything. Every later save/clear is a CAS on this token,
       so the retiring process cannot erase or overwrite the adopted break. */
    const claimed = await this.claimPersistedState(saved);
    if (!claimed) {
      throw new Error('maintenance_break_ownership_changed_before_adoption');
    }
    saved = claimed;
    this.lastDurableState = { ...claimed };
    if (!this.lifecycleIsCurrent(generation)) return;

    this.reason = saved.reason;
    this.announcedAt = saved.announcedAt;
    // A stored countdown plus the exact token-rotation receipt is already a
    // durable certificate. A stored last-hand row is about to be transformed
    // locally and remains unconfirmed until that transformed row commits.
    this.durableConfirmed = saved.phase === 'counting_down' && saved.breakEndsAt !== null;
    this.phase = 'counting_down';
    // The previous engine's start instant, so the thaw measures the WHOLE
    // freeze, not just the slice this process lived through.
    //
    // A `last_hand` row ALWAYS has `breakStartedAt === null` — `announceLastHand`
    // persists it that way — so `?? this.now()` meant every adopted break
    // measured its freeze from the BOOT instant, which is the same mistake the
    // end had. An engine booting at :58 recorded two minutes where six and a
    // half were held: `fn_thaw_platform` then handed back two, and every
    // in-flight deadline lost the rest. It also put the row outside the
    // scorecard's own `[:52, :58]` lookup, which reads as a thaw that never
    // ran. The break started when it was always going to start: :55, which is
    // `announcedAt + LAST_HAND_LEAD_MS`.
    this.breakStartedAt =
      saved.breakStartedAt ?? saved.announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS;
    this.breakEndsAt = endsAt;
    this.certifiedResumeAt = 0;
    setMaintenanceFrozen(true);

    console.log(
      `[MaintenanceBreak] Resumed a break left by the previous engine - ${Math.round(
        (this.breakEndsAt - this.now()) / 1000
      )}s remaining. Parking every table until it ends.`
    );

    this.parkEveryEngine();
    /* A stored last_hand row has no countdown end. Upgrade it durably before
       showing a countdown; a stored counting_down row already is that proof
       and must not be rewritten merely because a new process adopted it. */
    if (saved.phase === 'last_hand' && remaining > 1000) {
      const adopted = this.persistedState();
      try {
        await this.persist(adopted);
      } catch (error) {
        /* THE ADOPTED ROW IS ALREADY THE FREEZE (2026-09-10). The last-hand
           row this process has just claimed is durable, and the database
           honours it until it is deleted - fn_entry_purchases_frozen from the
           announcement, fn_platform_frozen from :55. Cancelling here used to
           resume the fleet under a countdown every screen was showing while
           the database went on refusing entries: the two halves disagreeing,
           which is the one outcome the row exists to prevent. So hold to the
           same end. All that is lost is the countdown certificate, and an
           adopting engine is not waiting for a restart. end() clears the
           claimed row through lastDurableState. */
        console.error(
          '[MaintenanceBreak] could not durably upgrade the adopted last-hand row; holding the break on the adopted row until it ends',
          error
        );
        this.reportFault('adoption', 'held_without_restart', error, saved.announcedAt);
      }
    }
    if (!this.lifecycleIsCurrent(generation)) return;
    this.broadcast('counting_down');
    this.armEndTimer();
  }

  /**
   * Park a table engine created while a break is running.
   *
   * GameServer builds engines continuously - the discovery sweep, on-demand
   * wake, a tournament starting - and after a restart it builds ALL of them.
   * An engine created at :58 that nobody parked would be the only table on the
   * platform dealing, which is both wrong and the loudest possible tell.
   */
  adopt(tableId: string, engine: PausableTableEngine): void {
    if (!this.acceptingLifecycleWork || !this.isActive()) return;
    engine.pauseForMaintenance(this.remainingParkBudgetMs());
    this.deps.emit(tableId, this.eventPayload(tableId));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scheduling - wall clock anchored, never interval based
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Anchor every firing to the wall clock and re-arm from the wall clock after
   * each one.
   *
   * `setInterval` was removed from the tournament break for this same reason:
   * a five-hour-old interval has drifted, and the drift compounds. Every timer
   * here is a one-shot computed from "what time is it now, when is the next
   * :53", so a slow event loop delays one break rather than skewing all of
   * them, and DST is handled by asking the calendar rather than by arithmetic.
   */
  private scheduleNextAnnouncement(): void {
    if (!this.started || !this.deps.isRunning()) return;
    if (this.announceTimer) this.clearTimer(this.announceTimer);

    const msUntil = this.msUntilNextAnnouncement();
    console.log(
      `[MaintenanceBreak] Next maintenance break announcement in ${Math.round(
        msUntil / 60000
      )} minute(s); the break runs :55 to :00 and carries the engine restart.`
    );

    const generation = this.lifecycleGeneration;
    this.announceTimer = this.setTimer(() => {
      this.announceTimer = null;
      if (!this.lifecycleIsCurrent(generation)) return;
      this.launchLifecycleJob(
        (async () => {
          try {
            await this.announceLastHand();
          } finally {
            if (this.lifecycleIsCurrent(generation)) {
              // A storage failure cancels this break, but it must not cancel
              // every future hour. Re-arm from the wall clock on both paths.
              this.scheduleNextAnnouncement();
            }
          }
        })(),
        'announcement failed'
      );
    }, msUntil);
  }

  /**
   * Milliseconds until the next :53.
   *
   * NO TIME ZONE IS INVOLVED, and that is the point of going hourly. The old
   * five-window schedule had to name Chicago hours, which meant either a
   * minute-by-minute scan through the tz database here or hand-rolled DST
   * arithmetic in the workflow - and on the two days a year the arithmetic is
   * wrong, the platform restarts an hour outside its announced break. Every
   * hour is a window now. UTC setters keep :53 aligned with the deployment
   * window during repeated local hours and fractional-hour offsets.
   *
   * Anchored to the wall clock and recomputed after every firing, never
   * accumulated: a slow event loop delays one break instead of skewing all of
   * them from then on.
   */
  private msUntilNextAnnouncement(): number {
    const announceMinute =
      MaintenanceBreak.BREAK_START_MINUTE - MaintenanceBreak.LAST_HAND_LEAD_MS / 60000;
    const now = this.now();
    const next = new Date(now);
    next.setUTCMinutes(announceMinute, 0, 0);
    let t = next.getTime();
    // Already past this hour's mark (the common case, since we are usually
    // re-arming a moment after firing): take the next hour's.
    if (t <= now) t += 60 * 60 * 1000;
    return t - now;
  }

  // `nextHourBoundary()` lived here and is DELETED (2026-09-07). It computed
  // "the next :00", which for a boot at exactly :00:00.000 meant the FOLLOWING
  // hour — a sixty-minute fleet freeze inside a sixty-second window that the
  // staleness guard happily admitted. The adopted break derives its end from
  // `announcedAt` now, which has no boundary case; see restoreFromStore.

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 1 - :53, last hand
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Tell every table to finish the hand in front of it and start no new one.
   *
   * `beforeNextHand: true` is the whole guarantee. It makes the deal loop
   * park at the TOP of its next iteration - before the short-handed sleep,
   * before the spin-reveal hold, before the admin-lock branch - so a table
   * that was idle at :53 parks too, rather than dealing a hand the moment a
   * seat fills at :56. A table with cards in the air still finishes, because
   * the loop cannot come back around until dealHand() resolves.
   */
  async announceLastHand(): Promise<void> {
    return this.announceBreak(this.now(), 'Scheduled Engine Maintenance');
  }

  /**
   * One explicit release request, using the ordinary durable maintenance flow.
   * The caller persists announcedAt before dispatch. Replaying that timestamp
   * can observe the same active break, but can never start a later one or move
   * its deadline. This method does not schedule another recovery request.
   */
  async requestRecoveryWindow(announcedAt: number): Promise<{
    status: 'accepted' | 'active' | 'pending' | 'busy' | 'expired' | 'use_hourly' | 'unavailable';
    announcedAt?: number;
    endsAt?: number;
  }> {
    if (!this.startOperation || !this.deps.assertRecoveryWindowContract) {
      return { status: 'unavailable' };
    }
    await this.startOperation;
    const evaluate = () => {
      if (!this.lifecycleIsCurrent(this.lifecycleGeneration) || !this.deps.isRunning()) {
        return 'unavailable' as const;
      }
      if (!Number.isSafeInteger(announcedAt) || announcedAt <= 0 || announcedAt > this.now()) {
        return 'expired' as const;
      }
      if (this.isActive()) {
        if (this.announcedAt === announcedAt && this.reason === 'Deployment Recovery') {
          return this.durableConfirmed ? ('active' as const) : ('pending' as const);
        }
        return 'busy' as const;
      }
      if (this.recoveryWindowIsBusy()) return 'busy' as const;
      if (
        this.completedAnnouncementAt === announcedAt ||
        this.now() >= announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS
      )
        return 'expired' as const;
      const end =
        announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS + MaintenanceBreak.BREAK_DURATION_MS;
      if (
        this.scheduledBreakWindowAt(this.now()) ||
        end + MaintenanceBreak.RESUME_SPREAD_MS >= this.now() + this.msUntilNextAnnouncement()
      )
        return 'use_hourly' as const;
      return null;
    };
    const observed = evaluate();
    if (observed)
      return {
        status: observed,
        announcedAt: this.announcedAt || undefined,
        endsAt: this.endsAt() || undefined,
      };
    await this.deps.assertRecoveryWindowContract();
    // The database check can overlap the hourly announcement or a competing
    // request. Re-evaluate before the first in-memory/persistent mutation.
    const raced = evaluate();
    if (raced)
      return {
        status: raced,
        announcedAt: this.announcedAt || undefined,
        endsAt: this.endsAt() || undefined,
      };
    await this.announceBreak(announcedAt, 'Deployment Recovery');
    if (!this.durableConfirmed || this.announcedAt !== announcedAt)
      return { status: 'unavailable' };
    return { status: 'accepted', announcedAt, endsAt: this.endsAt() };
  }

  /** Readiness to reserve an announcement; database authority is checked on request. */
  private recoveryWindowIsBusy(): boolean {
    return Boolean(
      this.ending ||
      this.recoveryReadPending ||
      this.releaseBoundaryOnly ||
      this.thawRequest ||
      this.pendingResumeTables.size > 0 ||
      this.certifiedResumeAt > this.now()
    );
  }

  private async announceBreak(announcedAt: number, reason: string): Promise<void> {
    const generation = this.lifecycleGeneration;
    if (!this.lifecycleIsCurrent(generation) || !this.deps.isRunning()) return;
    if (this.isActive()) return; // already in one

    this.durableConfirmed = false;
    this.phase = 'last_hand';
    this.announcedAt = announcedAt;
    this.reason = reason;
    this.breakEndsAt = 0;
    /* Keep this process generation's token across locally-created breaks.
       If the prior hour's exact clear committed but its response was lost, or
       the clear genuinely failed, the durable expired row still belongs to
       this process. Replacing the token here would make the next CAS save
       reject its rightful owner forever. Only restoreFromStore rotates a
       token, atomically, when a replacement process adopts somebody else's
       live break. Semantic timestamps still fence every exact clear. */
    // The previous rollout's record has been readable on /health for an
    // hour; the next one starts from nothing.
    this.resumeWaves = null;
    this.certifiedResumeAt = 0;
    this.pendingResumeTables.clear();
    // Freeze the engine's own sweeps from the announcement, not the countdown:
    // a horse standing up at :54 under a "Last Hand" banner is the same tell
    // as one standing up at :56, and nothing these sweeps do cannot wait.
    setMaintenanceFrozen(true);

    const tables = this.parkEveryEngine();
    console.log(
      `[MaintenanceBreak] ═══ LAST HAND ═══ ${tables} table(s) finishing up. ` +
        `The ${MaintenanceBreak.BREAK_DURATION_MS / 60000} minute maintenance break starts in ` +
        `${MaintenanceBreak.LAST_HAND_LEAD_MS / 60000} minute(s).`
    );

    const declared = this.persistedState();
    try {
      await this.persistAnnouncement(declared, generation);
    } catch (error) {
      await this.cancelBreakAfterPersistenceFailure(false, declared);
      this.reportFault('announcement', 'cancelled', error, declared.announcedAt);
      throw error;
    }
    if (!this.lifecycleIsCurrent(generation)) return;

    // The player-visible promise comes only after the database boundary is
    // durable. A process kill after this frame can therefore be adopted.
    this.broadcast('last_hand');

    if (this.countdownTimer) this.clearTimer(this.countdownTimer);
    /* The database save is allowed to wait behind an entry transaction that
       acquired the same maintenance boundary first. That wait proves the
       entry belongs before the freeze; it must not move the player-visible
       schedule. Both the SQL read side and the frame above derive the window
       from announcedAt, so arm only the time still left until that same
       absolute :55 boundary. */
    const countdownAt = this.announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS;
    this.countdownTimer = this.setTimer(
      () => {
        this.countdownTimer = null;
        if (!this.lifecycleIsCurrent(generation)) return;
        this.launchLifecycleJob(this.beginCountdown(), 'countdown failed to start');
      },
      Math.max(0, countdownAt - this.now())
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 2 - :55, the countdown players actually see
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Start the five minutes.
   *
   * The countdown begins here rather than at the announcement because the
   * number on screen has to mean something: a player who sat down at :54 is
   * told the break lasts five minutes, and it does. It is also the moment
   * `readyForRestart` opens, so the deploy cannot pull the engine out from
   * under a table that has not finished its hand.
   */
  async beginCountdown(): Promise<void> {
    const generation = this.lifecycleGeneration;
    if (!this.lifecycleIsCurrent(generation) || this.phase !== 'last_hand') return;

    // Anything created during the last-hand wait, and anything that somehow
    // slipped the first pass, is parked now. Cheap, and it makes "every table
    // is parked" true rather than probable.
    this.parkEveryEngine();

    const stragglers = this.unparkedTables();
    this.unparkedAtCountdown = stragglers.length;
    this.peakUnparked = stragglers.length;
    this.readyForRestartAtMs = null;
    if (stragglers.length > 0) {
      // Not fatal, and deliberately not blocking. A table wedged mid-hand must
      // not hold the platform's break open past the hour - the tournament
      // break made the same call for the same reason - but the restart gate
      // below refuses to fire while any table is unparked, so a straggler
      // costs us a restart window, never a player's hand.
      console.warn(
        `[MaintenanceBreak] ${stragglers.length} table(s) had not parked when the countdown ` +
          `started: ${stragglers.slice(0, 5).join(', ')}. The break runs on time; the restart ` +
          `gate stays shut until they land.`
      );
    }

    /* announcedAt is the durable schedule authority. A delayed save or a
       briefly delayed event loop may make this method execute after :55, but
       neither is permission to extend the break past the promised :00. These
       exact instants also match fn_entry_purchases_frozen and the last_hand
       frame's resume_expected_at. */
    const scheduledStartAt = this.announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS;
    const invokedAt = this.now();
    // The last-hand row is durable, but the countdown identity is not yet.
    // Close the deploy gate before changing any of its semantic fields.
    this.durableConfirmed = false;
    this.phase = 'counting_down';
    /* beginCountdown is also the explicit/manual entry point. An intentional
       early call starts its five minutes immediately; an on-time or late
       scheduled call stays anchored to the already-promised boundary and can
       never extend it. */
    this.breakStartedAt = invokedAt < scheduledStartAt ? invokedAt : scheduledStartAt;
    this.breakEndsAt = this.breakStartedAt + MaintenanceBreak.BREAK_DURATION_MS;

    console.log(
      `[MaintenanceBreak] ═══ BREAK STARTED ═══ ${
        MaintenanceBreak.BREAK_DURATION_MS / 60000
      } minutes. Play resumes at ${new Date(this.endsAt()).toISOString()}.`
    );

    /* THE BREAK NO LONGER DEPENDS ON THIS WRITE (2026-09-10).

       The last-hand row committed at :53 is already the database half of the
       freeze: fn_entry_purchases_frozen honours it from the announcement,
       fn_platform_frozen from :55, and neither lets go until the row is
       deleted. So from here the break runs to the promised :00 whatever this
       save does, and the countdown players see starts on time.

       What the save still decides is whether the hour carries a restart.
       readyForRestart stays shut until the countdown row is exact and durable
       (durableConfirmed), so the deploy never replaces this process on a break
       a new one could not adopt. The save is retried like the announcement's -
       it waits on the same exclusive boundary, behind the same entry doors -
       and gives up once there is no longer room for a restart in the window.

       It used to be the other way round. One failed save here cancelled a
       break players had been watching for two minutes, resumed every table
       at :55, and - if the cleanup failed too - left the database refusing
       entries behind a felt that was dealing. */
    this.broadcast('counting_down');
    this.armEndTimer();

    const countingDown = this.persistedState();
    try {
      await this.persistWithRetry(
        countingDown,
        generation,
        this.breakEndsAt - MaintenanceBreak.MIN_REMAINING_FOR_RESTART_MS,
        'countdown'
      );
    } catch (error) {
      if (!this.lifecycleIsCurrent(generation)) return;
      console.error(
        '[MaintenanceBreak] the countdown could not be made durable; the break holds on the ' +
          'durable announcement until the hour and carries no restart this hour',
        error
      );
      this.reportFault('countdown', 'held_without_restart', error, countingDown.announcedAt);
    }
  }

  private armRecoveryRetry(): void {
    if (this.endTimer) this.clearTimer(this.endTimer);
    const generation = this.lifecycleGeneration;
    this.endTimer = this.setTimer(() => {
      this.endTimer = null;
      if (this.lifecycleIsCurrent(generation))
        this.launchLifecycleJob(this.end(), 'recovery retry failed');
    }, MaintenanceBreak.THAW_RETRY_MS);
  }

  private holdForRecoveryRead(): void {
    this.phase = 'counting_down';
    this.recoveryReadPending = true;
    this.durableConfirmed = false;
    setMaintenanceFrozen(true);
    this.parkEveryEngine();
    this.armRecoveryRetry();
  }

  private holdForReleaseBoundary(releaseAt: number): void {
    if (!Number.isFinite(releaseAt) || releaseAt <= 0) {
      throw new MaintenanceThawError('maintenance_release_boundary_invalid', false);
    }
    this.phase = 'counting_down';
    this.releaseBoundaryOnly = true;
    this.announcedAt = 0;
    this.breakStartedAt = 0;
    this.breakEndsAt = releaseAt;
    this.certifiedResumeAt = releaseAt;
    this.durableConfirmed = false;
    this.reason = 'Restoring every frozen table clock';
    setMaintenanceFrozen(true);
    this.parkEveryEngine();
    this.armEndTimer();
  }

  private async waitForCertifiedRelease(releaseAt: number, generation: number): Promise<void> {
    const signal = this.lifecycleAbort.signal;
    let boundary = releaseAt;
    while (this.lifecycleIsCurrent(generation)) {
      const remaining = boundary - this.now();
      if (remaining > 0) await waitForMaintenanceThaw(remaining, signal);
      if (!this.lifecycleIsCurrent(generation)) return;
      const currentBoundary = await this.deps.store.loadReleaseBoundary();
      if (!this.lifecycleIsCurrent(generation)) return;
      if (currentBoundary === null) return;
      if (!Number.isFinite(currentBoundary) || currentBoundary <= 0) {
        throw new MaintenanceThawError('maintenance_release_boundary_invalid', false);
      }
      if (boundary !== currentBoundary) {
        this.certifiedResumeAt = currentBoundary;
        this.broadcast('counting_down');
      }
      boundary = currentBoundary;
      // A fast host clock cannot release while the database still reports a
      // future certificate. Wait between those skew-correction reads.
      if (boundary <= this.now()) await waitForMaintenanceThaw(250, signal);
    }
  }

  private armEndTimer(): void {
    if (this.endTimer) this.clearTimer(this.endTimer);
    const remaining = Math.max(0, this.breakEndsAt - this.now());
    const generation = this.lifecycleGeneration;
    this.endTimer = this.setTimer(() => {
      this.endTimer = null;
      if (!this.lifecycleIsCurrent(generation)) return;
      this.launchLifecycleJob(this.end(), 'resume failed');
    }, remaining);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 3 - :00, everybody plays again
  // ─────────────────────────────────────────────────────────────────────────

  /** The v3 transaction owns durable release. Local gates follow its certificate. */
  /**
   * Re-entrancy latch for end(). The idle check alone is not enough: the
   * phase only becomes 'idle' AFTER the awaited thaw completes, so the armed
   * end-timer and a concurrent caller (a second timer, a manual end) could
   * both pass the guard during that await and run the whole resume twice.
   * The unit test caught exactly that - ['thaw','thaw','resume','resume'].
   * The thaw RPC is idempotent server-side, but relying on the last line of
   * defence to absorb a bug in the first is how defences get spent.
   */
  private ending = false;

  async end(): Promise<void> {
    const generation = this.lifecycleGeneration;
    if (!this.lifecycleIsCurrent(generation) || this.phase === 'idle' || this.ending) return;
    this.ending = true;
    if (this.resumeExpectedAt() <= this.now()) this.broadcast('finalizing');

    let reconnectFreezeStartedAt = this.breakStartedAt;
    let thawOk: boolean | null = null;
    try {
      if (this.recoveryReadPending) {
        this.recoveryReadPending = false;
        // Keep the existing table gates and process freeze held while the
        // ordinary recovery path obtains a durable row or release witness.
        this.phase = 'idle';
        await this.restoreFromStore(generation);
        if (!this.lifecycleIsCurrent(generation)) {
          this.ending = false;
          return;
        }
        if (this.phase !== 'idle') {
          this.ending = false;
          return;
        }
        this.phase = 'counting_down';
        this.releaseBoundaryOnly = true;
      }
      if (this.releaseBoundaryOnly) {
        await this.waitForCertifiedRelease(this.breakEndsAt, generation);
      } else if (this.deps.thaw) {
        const durable = this.lastDurableState;
        if (!durable || durable.ownershipToken !== this.ownershipToken) {
          throw new MaintenanceThawError('maintenance_thaw_durable_identity_unproven', false);
        }
        const freezeStartedAt =
          durable.breakStartedAt ?? durable.announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS;
        const request =
          this.thawRequest ??
          Object.freeze({
            announcedAt: durable.announcedAt,
            freezeStartedAt,
            frozenSeconds: Math.max(1, (this.now() - freezeStartedAt) / 1000),
            ownershipToken: durable.ownershipToken,
          });
        this.thawRequest = request;
        const release = await this.deps.thaw(request, this.lifecycleAbort.signal);
        if (
          !this.lifecycleIsCurrent(generation) ||
          this.ownershipToken !== request.ownershipToken
        ) {
          this.ending = false;
          return;
        }
        assertMaintenanceThawRelease(request, release);
        this.certifiedResumeAt = release.creditedThroughAt;
        this.broadcast('counting_down');
        await this.waitForCertifiedRelease(release.creditedThroughAt, generation);
        reconnectFreezeStartedAt = request.freezeStartedAt;
        thawOk = true;
      }
    } catch (error) {
      this.ending = false;
      if (!this.lifecycleIsCurrent(generation)) return;
      console.error('[MaintenanceBreak] thaw/release unproven; keeping every table paused', error);
      if (!(error instanceof MaintenanceThawError) || error.retryable) this.armRecoveryRetry();
      return;
    }
    if (!this.lifecycleIsCurrent(generation)) {
      this.ending = false;
      return;
    }
    if (reconnectFreezeStartedAt > 0) {
      completeReconnectFreeze(reconnectFreezeStartedAt, this.now() - reconnectFreezeStartedAt);
    }
    const outcome: MaintenanceBreakOutcome = {
      breakStartedAtMs: this.breakStartedAt,
      breakEndedAtMs: this.now(),
      unparkedAtCountdown: this.unparkedAtCountdown,
      peakUnparked: this.peakUnparked,
      readyForRestartAtMs: this.readyForRestartAtMs,
      tablesResumed: 0,
      thawOk,
    };
    const completedState = this.releaseBoundaryOnly ? null : this.persistedState();
    const durableState = this.lastDurableState;
    const releasedByV3 = this.releaseBoundaryOnly || Boolean(this.deps.thaw);
    this.releaseBoundaryOnly = false;
    this.thawRequest = null;
    /**
     * THE BREAK IS OVER BEFORE THE FIRST TABLE WAKES (review fix, 2026-09-03).
     *
     * The resume waves fire RESUME_WAVE_GAP_MS apart and each
     * one checks `this.phase === 'idle'` so a wave left over from a break
     * that has since been superseded cannot wake a table the next break is
     * holding. That check used to be satisfied only AFTER `recordOutcome`
     * resolved, and recordOutcome is a database insert made at :00 - the one
     * instant the database is guaranteed to be at its slowest (statement
     * timeouts of up to 8s are routine there). An insert slower than 750ms
     * would have dropped the second wave; one slower than 10s would have dropped
     * every later wave of a 355-table fleet, and a dropped table cannot
     * recover: the pause safety timeout wakes it, the loop's own gate sees
     * `maintenancePaused` still set and parks it again, forever. The 23:55
     * restart's insert took 170ms, which is why 355 tables came back; that
     * is luck, not design. So: the break goes idle FIRST, then the tables
     * are woken. The outcome was captured above, so the record stays honest.
     */
    this.completedAnnouncementAt = this.announcedAt;
    this.phase = 'idle';
    this.durableConfirmed = false;
    this.lastDurableState = null;
    this.breakStartedAt = 0;
    this.breakEndsAt = 0;
    this.announcedAt = 0;
    this.ending = false;
    setMaintenanceFrozen(false);

    const resumed = this.resumeEveryEngine(
      reconnectFreezeStartedAt > 0 ? reconnectFreezeStartedAt : undefined
    );
    outcome.tablesResumed = resumed;
    // The break's own scorecard line. Never allowed to delay or fail the
    // resume: wave 0 has already fired and the rest are scheduled by the
    // time this is awaited, and nothing below gates them.
    if (this.deps.recordOutcome && reconnectFreezeStartedAt > 0) {
      try {
        await this.deps.recordOutcome(outcome);
        if (!this.lifecycleIsCurrent(generation)) return;
      } catch (err) {
        console.warn('[MaintenanceBreak] could not record the break outcome', err);
      }
    }

    console.log(
      `[MaintenanceBreak] BREAK ENDED. Resumed ${resumed} table(s). ` +
        `Unparked at countdown ${outcome.unparkedAtCountdown}, peak ${outcome.peakUnparked}, ` +
        `readyForRestart ${
          outcome.readyForRestartAtMs === null
            ? 'never'
            : 'at ' + new Date(outcome.readyForRestartAtMs).toISOString()
        }.`
    );
    if (!releasedByV3 && completedState) await this.safeClear(completedState);
    /* A countdown or an adoption upgrade that never became durable leaves the
       earlier row in the database, and that row freezes entries until it is
       deleted. Both clears are exact compare-and-deletes on this process's
       token, so whichever does not match the stored row is a no-op. */
    if (
      !releasedByV3 &&
      completedState &&
      durableState &&
      !MaintenanceBreak.samePersistedState(durableState, completedState)
    ) {
      await this.safeClear(durableState);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Engine fan-out
  // ─────────────────────────────────────────────────────────────────────────

  private parkEveryEngine(): number {
    let n = 0;
    const budget = this.remainingParkBudgetMs();
    for (const [tableId, engine] of this.deps.engines()) {
      try {
        engine.pauseForMaintenance(budget);
        n++;
      } catch (err) {
        console.warn(`[MaintenanceBreak] could not park table ${tableId}`, err);
      }
    }
    return n;
  }

  private resumeEveryEngine(reconnectFreezeStartedAt?: number, publish = true): number {
    // Collect the tables this break is responsible for resuming.
    // EVERY table gets resumeFromMaintenance(), including one another
    // authority is still holding. This used to `continue` past those, and
    // that stranded them PERMANENTLY (2026-09-03):
    //
    //   - resumeFromMaintenance() is the ONLY thing that clears
    //     maintenancePaused, and skipping the table meant it was never called;
    //   - the tournament's own resumeDealing() early-returns while
    //     maintenancePaused is set, precisely so hand-for-hand cannot deal
    //     inside a break.
    //
    // So both authorities deferred to each other and nobody ever released the
    // table. It sat dark until reviveDeadTableEngines noticed it had been
    // paused past MAX_HEALTHY_PAUSE_MS (10 min) and TORE THE ENGINE DOWN to
    // rebuild it - a tournament dark for five to ten extra minutes, recovered
    // by demolition rather than by resuming.
    //
    // Calling it here is safe and always was: resumeFromMaintenance() clears
    // only its OWN flag and returns without releasing the gate whenever
    // handForHandPaused is set, and every tournament break holds its tables
    // through pauseAfterHand(), which sets exactly that flag. The break
    // releases what the break took; the other authority keeps what it took.
    const resumable: Array<[string, PausableTableEngine]> = [];
    for (const [tableId, engine] of this.deps.engines()) {
      try {
        if (this.deps.shouldStayPaused?.(tableId)) {
          // Informational only now. The table still will not deal - its own
          // authority holds the gate - but its maintenance flag gets cleared
          // so that authority can actually release it when it is done.
          console.log(
            `[MaintenanceBreak] ${tableId} stays held by its tournament's own break; clearing only the maintenance flag.`
          );
        }
        resumable.push([tableId, engine]);
      } catch (err) {
        console.warn(`[MaintenanceBreak] could not inspect table ${tableId} for resume`, err);
      }
    }

    const waves = MaintenanceBreak.planResumeWaves(resumable);
    const token = ++this.resumeToken;
    const progress: ResumeWavesProgress = {
      total: waves.length,
      done: 0,
      startedAt: this.now(),
      finishedAt: null,
      tables: resumable.length,
      tablesResumed: 0,
      gapMs: MaintenanceBreak.RESUME_WAVE_GAP_MS,
    };
    this.resumeWaves = progress;
    this.pendingResumeTables = new Set(resumable.map(([id]) => id));
    if (publish) this.broadcast('resuming');

    const fireWave = (index: number): void => {
      for (const [tableId, engine] of waves[index]) {
        try {
          if (reconnectFreezeStartedAt !== undefined) {
            completeTableReconnectFreeze(tableId, reconnectFreezeStartedAt, this.now());
          }
          engine.resumeFromMaintenance();
          this.pendingResumeTables.delete(tableId);
          if (publish) this.broadcastEnded(tableId);
        } catch (err) {
          // One table that refuses to resume must not strand the rest of its
          // wave, and never the waves behind it.
          console.warn(`[MaintenanceBreak] could not resume table ${tableId}`, err);
        }
        progress.tablesResumed++;
      }
      progress.done = index + 1;
      if (progress.done === progress.total) {
        progress.finishedAt = this.now();
        if (publish) this.publishPresentation();
      }
    };

    // Wave 0 resumes NOW, synchronously: a small fleet (and every test fleet)
    // is fully up before end() returns, and there is no visible spread below
    // RESUME_WAVE_MIN_TABLES.
    if (waves.length > 0) fireWave(0);

    // The remaining waves roll out RESUME_WAVE_GAP_MS apart, in the
    // background. A wave from a superseded break (resumeToken changed) is
    // dropped rather than waking a table the next break is holding.
    for (let w = 1; w < waves.length; w++) {
      let timer!: NodeJS.Timeout;
      timer = this.setTimer(() => {
        this.resumeWaveTimers.delete(timer);
        // Drop a stale wave: a newer break has superseded this rollout
        // (resumeToken bumped), or a break is once again active and holding
        // these tables (phase left idle). Waking them now would deal a table
        // back into a break it is supposed to be paused in.
        if (this.resumeToken !== token || this.phase !== 'idle') return;
        fireWave(w);
      }, w * MaintenanceBreak.RESUME_WAVE_GAP_MS);
      this.resumeWaveTimers.add(timer);
    }

    if (waves.length > 1) {
      console.log(
        `[MaintenanceBreak] resuming ${resumable.length} table(s) in ${waves.length} wave(s), ` +
          `${MaintenanceBreak.RESUME_WAVE_GAP_MS}ms apart (${
            (waves.length - 1) * MaintenanceBreak.RESUME_WAVE_GAP_MS
          }ms first to last).`
      );
    }

    // Every table in `resumable` receives exactly one resume; the count is
    // honest at call time even though the later waves wake shortly after.
    return resumable.length;
  }

  /**
   * Deal the fleet into waves. Pure and exported for the tests.
   *
   * - Wave count: ceil(total / RESUME_WAVE_MIN_TABLES), capped at
   *   RESUME_WAVES. 3 tables = 1 wave; 60 = 3; 720 = 8 (90 per wave).
   * - Order: within each kind (cash / tournament), by a stable FNV-1a hash of
   *   the table id, ties by id. Nothing about the seats is consulted.
   * - Interleave: table k of each kind goes to wave k mod waves, so every
   *   wave carries its share of both kinds and no wave is all tournaments.
   *
   * THE ORDER DOES NOT BURN A CLOCK. `end()` computes frozenSeconds as
   * now - breakStartedAt and awaits fn_thaw_platform BEFORE wave 0. That
   * shift is uniform and keyed to the freeze start, so it is the same
   * whether a table wakes in wave 0 or wave 7. Every deadline it moves
   * (sit_out_at, waitlist holds, add-on and rebuy windows, bounty reveals,
   * bomb-pot due, tournament level_started_at) is judged at minute scale;
   * the extra 0-10.5s a late wave adds is the same order as the loop's own
   * between-hand sleep and smaller than the 21s the phase 3 stagger already
   * imposed on a 720-table fleet without a per-table shift. A per-table
   * second shift would be one database write per table at :00 - the herd
   * this whole module exists to avoid - so it is deliberately not done.
   */
  static planResumeWaves<E extends Pick<PausableTableEngine, 'isTournament'>>(
    tables: ReadonlyArray<[string, E]>
  ): Array<Array<[string, E]>> {
    if (tables.length === 0) return [];
    const waves = Math.max(
      1,
      Math.min(
        MaintenanceBreak.RESUME_WAVES,
        Math.ceil(tables.length / MaintenanceBreak.RESUME_WAVE_MIN_TABLES)
      )
    );
    const byKey = (a: [string, E], b: [string, E]) => {
      const ha = fnv1a(a[0]);
      const hb = fnv1a(b[0]);
      if (ha !== hb) return ha - hb;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    };
    const cash: Array<[string, E]> = [];
    const tournament: Array<[string, E]> = [];
    for (const t of tables) {
      let isTournament = false;
      try {
        isTournament = t[1].isTournament?.() === true;
      } catch {
        /* an engine that cannot say is cash for ordering purposes */
      }
      (isTournament ? tournament : cash).push(t);
    }
    cash.sort(byKey);
    tournament.sort(byKey);
    const out: Array<Array<[string, E]>> = Array.from({ length: waves }, () => []);
    for (const kind of [cash, tournament]) {
      kind.forEach((t, k) => out[k % waves].push(t));
    }
    return out;
  }

  /**
   * Tables that must not be restarted right now: running, with a hand in
   * flight.
   *
   * THIS TEST HAS BEEN WRONG THREE TIMES, and each time in a way the previous
   * fix's comment could not see. All three are worth keeping.
   *
   * TOO LOOSE (caught by the unit test): it accepted `isPausedByDesign()`,
   * which goes true the instant the pause is REQUESTED - so it was true for a
   * table with four players all-in and cards still in the air. The gate opened
   * at :55 whether or not a single hand had finished.
   *
   * TOO TIGHT (caught by an audit before this shipped): the fix used
   * `isWaitingForHandForHand()`, true only for a table that reached the gate
   * from the DEALING loop. A quiet table sits in the start-up wait loop and
   * never gets there, so every quiet table counted as unparked FOREVER.
   *
   * STILL TOO TIGHT (PHASE 2, measured 2026-09-02): the second fix used
   * `isParkedBetweenHands()`, which is true only while a loop is literally
   * blocked on the pause-gate promise. A table anywhere ELSE in its loop -
   * the wait loop's 5s sleep, loadSeatedPlayers, the idle broadcast, the
   * dealing loop between hands but before the gate - read as unparked with no
   * cards out at all. On the 17:55 break, with ZERO hands dealt inside it,
   * 64-70 tables held the gate shut for the whole five minutes; the deploy
   * gave up at :00 and the fallback restarted the engine at 18:02 on live
   * tables. The gate had never once opened on any real break.
   *
   * The honest question is not "has a loop reached the gate" but "are there
   * cards in the air". `isBetweenHands()` is exactly that: handController is
   * null, which the engine sets only AFTER the hand-complete listener has
   * settled the pot (and on the void/abort paths, where there is nothing to
   * settle). A table with no hand in flight loses nothing to a restart,
   * wherever its loop happens to be; a table WITH one holds the gate until
   * it finishes, and `maintenancePaused` stops it starting another. This is
   * also the predicate the mystery-bounty phase already trusts to move money
   * only between hands.
   *
   * A stopped engine is not counted: it has no hand to protect.
   */
  /** Last reason breakdown computed by `unparkedTables`, for /health. */
  private unparkedReasonCounts: Record<string, number> = {};

  private unparkedTables(): string[] {
    const out: string[] = [];
    const reasons: Record<string, number> = {};
    const count = (reason: string) => {
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    };
    for (const [tableId, engine] of this.deps.engines()) {
      try {
        if (engine.hasUnresolvedF06Preparation?.()) {
          out.push(tableId);
          count('f06_preparation_unresolved');
          continue;
        }
        if (!engine.isRunning()) continue;
        if (!engine.isBetweenHands()) {
          out.push(tableId);
          count('cards_in_air');
          continue;
        }
        if (engine.isMaintenanceStateDurable?.() === false) {
          out.push(tableId);
          // The engine's own answer when it has one; an engine that only
          // publishes the boolean is counted, not guessed at.
          count(engine.maintenanceDurabilityReason?.() ?? 'unknown');
        }
      } catch {
        // Unreadable engines are not counted against the gate; an engine that
        // throws on inspection is already being handled by the reapers.
      }
    }
    this.unparkedReasonCounts = reasons;
    if (this.phase === 'counting_down' && out.length > this.peakUnparked) {
      this.peakUnparked = out.length;
    }
    return out;
  }

  /**
   * The park budget shrinks as the break runs down, so a table parked at :58
   * gets two minutes rather than a fresh seven and cannot outlive the break.
   */
  private remainingParkBudgetMs(): number {
    if (this.phase === 'counting_down' && this.breakEndsAt > 0) {
      return Math.max(30_000, this.breakEndsAt - this.now() + 30_000);
    }
    return MaintenanceBreak.PARK_BUDGET_MS;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Broadcast
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * When the engine expects to be answering sockets again.
   *
   * At `counting_down` the break end is already fixed, so it is that. At
   * `last_hand` nothing has been written yet, so it is derived from the
   * announcement: the two-minute lead plus the five-minute break. Derived, not
   * guessed - both are constants pinned by `the-break-clocks-agree`.
   *
   * Zero when there is no break, which the client reads as "no window".
   */
  private resumeExpectedAt(): number {
    if (this.breakEndsAt > 0) return this.breakEndsAt;
    if (this.announcedAt > 0) {
      return (
        this.announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS + MaintenanceBreak.BREAK_DURATION_MS
      );
    }
    return 0;
  }

  presentation(tableId?: string) {
    const active = this.isActive();
    const resuming = tableId
      ? this.pendingResumeTables.has(tableId)
      : this.pendingResumeTables.size > 0;
    const expected = this.certifiedResumeAt || this.resumeExpectedAt();
    const phase: MaintenancePresentationPhase = active
      ? this.phase === 'last_hand'
        ? 'last_hand'
        : expected > this.now()
          ? 'counting_down'
          : 'finalizing'
      : resuming
        ? 'resuming'
        : 'idle';
    return {
      active: active || resuming,
      phase,
      break_id: (active ? this.announcedAt : this.completedAnnouncementAt) || null,
      break_ends_at: active && expected > this.now() ? expected : null,
      scheduled_ends_at: this.resumeExpectedAt() || null,
      reason: this.reason,
      timestamp: this.now(),
    };
  }

  /** Authenticated rejoin/RESYNC asks for current state, including explicit idle. */
  replay(tableId: string): void {
    if (!this.acceptingLifecycleWork) return;
    if (this.presentation(tableId).active) {
      this.deps.emit(tableId, this.eventPayload(tableId));
    } else {
      this.broadcastEnded(tableId);
    }
  }

  private eventPayload(tableId: string) {
    const presentation = this.presentation(tableId);
    const resumeAt = presentation.break_ends_at ?? 0;
    return {
      type: 'maintenance_break',
      table_id: tableId,
      phase: presentation.phase,
      break_id: presentation.break_id,
      scheduled_ends_at: presentation.scheduled_ends_at,
      // Absolute epoch ms, not a duration. The client ticks its own countdown
      // from this so it keeps counting through the restart, when there is no
      // engine to ask and no socket to ask it on.
      break_ends_at: presentation.break_ends_at,
      duration_ms: MaintenanceBreak.BREAK_DURATION_MS,
      /* ═══ THE RESTART HANDOFF (Realtime Phase 4, 2026-09-05) ═════════════
         Two numbers the RECONNECT LADDER needs, as opposed to the countdown
         a player reads. They are on this frame rather than a new one because
         this frame already reaches every subscribed socket at exactly the
         right moment, and an unknown field is ignored by every client that
         has not learned to read it yet.

         `restart_in_ms`  - how long until the socket goes away. Two minutes
                            at :53, zero once the countdown has started and
                            the engine may be pulled at any moment.
         `resume_expected_at` - absolute epoch ms, when it should be back.

         WHY THE LADDER NEEDS THEM. Without this, the engine going down for
         its scheduled ~3 minutes is indistinguishable from the box dying:
         the client ladders 1s, 2s, 4s ... 30s, reaches maxRetries at roughly
         three minutes, announces 'failed', and TablePage's twenty-second
         failsafe reloads the page - every hour, on a schedule, under a
         player who was told their seat would survive. It also asks GoTrue
         whether the session is still alive, because three failed handshakes
         in a row is exactly the shape of the 2026-09-03 outage; here it is
         not, and we already know why. */
      restart_in_ms: Math.max(0, resumeAt - MaintenanceBreak.BREAK_DURATION_MS - this.now()),
      resume_expected_at: resumeAt > 0 ? resumeAt : null,
      reason: this.reason,
      timestamp: this.now(),
    };
  }

  private broadcast(_phase: MaintenancePresentationPhase): void {
    this.publishPresentation();
    for (const [tableId] of this.deps.engines()) {
      try {
        this.deps.emit(tableId, this.eventPayload(tableId));
      } catch (err) {
        console.warn(`[MaintenanceBreak] could not announce to table ${tableId}`, err);
      }
    }
  }

  private publishPresentation(): void {
    try {
      this.deps.emitPresentation?.(this.presentation());
    } catch (err) {
      console.warn(`[MaintenanceBreak] could not publish presentation`, err);
    }
  }

  private broadcastEnded(tableId: string): void {
    try {
      this.deps.emit(tableId, {
        type: 'maintenance_break_ended',
        table_id: tableId,
        break_id: this.completedAnnouncementAt || null,
        timestamp: this.now(),
      });
    } catch (err) {
      console.warn(`[MaintenanceBreak] could not signal break end to table ${tableId}`, err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Persistence
  // ─────────────────────────────────────────────────────────────────────────

  private persistedState(): PersistedMaintenanceBreak {
    if (this.phase === 'idle') {
      throw new Error('an idle maintenance break has no durable state');
    }
    return {
      phase: this.phase,
      announcedAt: this.announcedAt,
      breakStartedAt: this.breakStartedAt > 0 ? this.breakStartedAt : null,
      breakEndsAt: this.breakEndsAt > 0 ? this.breakEndsAt : null,
      reason: this.reason,
      ownershipToken: this.ownershipToken,
    };
  }

  private static samePersistedState(
    left: PersistedMaintenanceBreak | null,
    right: PersistedMaintenanceBreak
  ): boolean {
    return (
      left !== null &&
      left.phase === right.phase &&
      left.announcedAt === right.announcedAt &&
      left.breakStartedAt === right.breakStartedAt &&
      left.breakEndsAt === right.breakEndsAt &&
      left.reason === right.reason &&
      left.ownershipToken === right.ownershipToken
    );
  }

  /**
   * How long the announcement keeps trying to make its durable promise, and
   * how long it rests between tries.
   *
   * THE SAVE WAITS BEHIND EVERY ENTRY IN FLIGHT (2026-09-10). The row write
   * takes the maintenance boundary exclusively; every buy-in, rebuy, Spin
   * draw and seat-first fill holds it shared for the life of its transaction,
   * and those money doors run under a 30 s statement budget while the save
   * runs under a 5 s lock budget. So on a busy hour one slow buy-in (27 s
   * observed) makes the save fail with "canceling statement due to lock
   * timeout" - and one such failure used to cancel the WHOLE break: no
   * last-hand row, no :55 countdown, no readyForRestart certificate, and the
   * deploy that was waiting on it shipped nothing. That is how 06:53 UTC on
   * 2026-09-10 left production a merge behind for an hour with nobody told.
   *
   * The database itself accepts a last-hand row until announcedAt + 2 min
   * (fn_save_engine_maintenance_break: MAINTENANCE_LAST_HAND_BOUNDARY_EXPIRED),
   * and the countdown is armed from that same absolute announcedAt, so a
   * retry inside the lead changes nothing a player sees: the :55 boundary
   * stays where it was announced. The budget stops well short of the two
   * minutes so a late success never races the countdown's own save.
   *
   * Only a lock or statement timeout is retried. An ownership loss, an
   * expired boundary, or an unreachable database is a decision, not a queue,
   * and still cancels straight away.
   */
  static readonly ANNOUNCE_PERSIST_BUDGET_MS = 90 * 1000;
  static readonly ANNOUNCE_PERSIST_RETRY_MS = 5 * 1000;

  /**
   * A failure worth another try inside the same budget (2026-09-10).
   *
   * Lock and statement timeouts, as before, plus the transport failures that
   * say nothing about the database's answer: the request timed out on this
   * side, the socket dropped, or a gateway in front of PostgREST could not
   * reach it. Re-sending is safe for exactly this write and no other: the save
   * is a compare-and-set on this process's ownership token, so an attempt that
   * did land makes the next one a no-op upsert of the same state, and
   * `persist` has already done the exact read-back before this is asked.
   * (The shared client deliberately retries none of these - CLAUDE.md,
   * production DDL policy rule 6 - because replaying an arbitrary executed
   * write is a money hazard. This one is idempotent by construction.)
   *
   * Every refusal the database gives on purpose - an ownership loss, an
   * expired boundary, a missing token - is still a decision, not a queue.
   */
  static isRetryablePersistenceError(error: unknown): boolean {
    const text = String((error as Error)?.message ?? error ?? '');
    if (/MAINTENANCE_[A-Z_]+/.test(text)) return false;
    if (MaintenanceBreak.isLockOrStatementTimeout(error)) return true;
    return /supabase_timeout|fetch failed|AbortError|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|other side closed|PGRST00[0-3]|deadlock detected|40P01|Bad Gateway|Service Unavailable|Gateway Time-?out/i.test(
      text
    );
  }

  static isLockOrStatementTimeout(error: unknown): boolean {
    const text = String((error as Error)?.message ?? error ?? '');
    if (
      /MAINTENANCE_(OWNERSHIP_LOST|LAST_HAND_BOUNDARY_EXPIRED|COUNTDOWN_BOUNDARY_EXPIRED)/.test(
        text
      )
    ) {
      return false;
    }
    return /lock timeout|statement timeout|lock_not_available|55P03|canceling statement/i.test(
      text
    );
  }

  private async persistAnnouncement(
    state: PersistedMaintenanceBreak,
    generation: number
  ): Promise<void> {
    await this.persistWithRetry(
      state,
      generation,
      state.announcedAt + MaintenanceBreak.ANNOUNCE_PERSIST_BUDGET_MS,
      'announcement'
    );
  }

  /**
   * One durable write, retried every ANNOUNCE_PERSIST_RETRY_MS while the
   * failure is retryable and there is budget left before `deadline`. Stops
   * the moment the local phase has moved on, so a late success can never
   * re-declare a phase this process has already left - and the database
   * refuses a late one anyway (its boundary checks run after the lock).
   */
  private async persistWithRetry(
    state: PersistedMaintenanceBreak,
    generation: number,
    deadline: number,
    what: 'announcement' | 'countdown'
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.persist(state);
        if (attempt > 1) {
          console.warn(
            `[MaintenanceBreak] the ${what} became durable on attempt ${attempt}; the announced boundaries are unchanged`
          );
        }
        return;
      } catch (error) {
        const rest = MaintenanceBreak.ANNOUNCE_PERSIST_RETRY_MS;
        if (
          !MaintenanceBreak.isRetryablePersistenceError(error) ||
          !this.lifecycleIsCurrent(generation) ||
          this.phase !== state.phase ||
          this.now() + rest > deadline
        ) {
          throw error;
        }
        console.warn(
          `[MaintenanceBreak] the ${what} save failed (attempt ${attempt}); retrying in ${
            rest / 1000
          }s, ${Math.max(0, Math.round((deadline - this.now()) / 1000))}s of budget left: ${
            (error as Error)?.message ?? error
          }`
        );
        await new Promise<void>((resolve) => this.setTimer(resolve, rest));
      }
    }
  }

  /** Hand the reason a break did not run as announced to recordFault, best-effort. */
  private reportFault(
    stage: MaintenanceBreakFault['stage'],
    outcome: MaintenanceBreakFault['outcome'],
    error: unknown,
    announcedAtMs: number
  ): void {
    const record = this.deps.recordFault;
    if (!record || !announcedAtMs) return;
    const fault: MaintenanceBreakFault = {
      announcedAtMs,
      stage,
      outcome,
      error: String((error as Error)?.message ?? error ?? 'unknown').slice(0, 500),
    };
    this.launchLifecycleJob(
      record(fault),
      'could not record why the break did not run as announced'
    );
  }

  private async persist(state = this.persistedState()): Promise<void> {
    try {
      await this.deps.store.save(state);
      this.durableConfirmed = true;
      this.lastDurableState = { ...state };
      return;
    } catch (saveError) {
      /* A timed-out HTTP response can hide a committed upsert. Read the row
         once and accept only a byte-for-byte semantic match. This is receipt
         recovery, not an unbounded retry: a missing, different, or unreadable
         row means the promise was not durably made and the caller cancels. */
      try {
        const stored = await this.deps.store.load();
        if (MaintenanceBreak.samePersistedState(stored, state)) {
          console.warn(
            '[MaintenanceBreak] persistence response was lost, but exact durable state was verified'
          );
          this.durableConfirmed = true;
          this.lastDurableState = { ...state };
          return;
        }
      } catch (readError) {
        console.error('[MaintenanceBreak] persistence read-back also failed', readError);
      }
      throw saveError;
    }
  }

  private async cancelBreakAfterPersistenceFailure(
    wasVisible: boolean,
    ...ownedStates: PersistedMaintenanceBreak[]
  ): Promise<void> {
    for (const timer of [this.countdownTimer, this.endTimer]) {
      if (timer) this.clearTimer(timer);
    }
    this.countdownTimer = null;
    this.endTimer = null;
    this.resumeToken += 1;
    for (const timer of this.resumeWaveTimers) this.clearTimer(timer);
    this.resumeWaveTimers.clear();

    this.completedAnnouncementAt = this.announcedAt;
    this.phase = 'idle';
    this.durableConfirmed = false;
    this.announcedAt = 0;
    this.breakStartedAt = 0;
    this.breakEndsAt = 0;
    this.ending = false;
    setMaintenanceFrozen(false);
    this.resumeEveryEngine(undefined, wasVisible);

    // Compare-and-delete each state this process may have committed. The
    // store implementation includes every field in the DELETE predicate, so
    // a newer owner or phase can never be erased by this cleanup.
    for (const state of ownedStates) await this.safeClear(state);
    this.lastDurableState = null;
  }

  private async safeClear(expected: PersistedMaintenanceBreak): Promise<void> {
    try {
      await this.deps.store.clear(expected);
    } catch (err) {
      console.error('[MaintenanceBreak] failed to clear the break row', err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Read side - /health and the deploy gate
  // ─────────────────────────────────────────────────────────────────────────

  isActive(): boolean {
    return this.phase !== 'idle';
  }

  remainingMs(): number {
    if (this.phase !== 'counting_down' || this.breakEndsAt === 0) return 0;
    return Math.max(0, this.breakEndsAt - this.now());
  }

  /**
   * When the platform comes off this break, as epoch ms; 0 when none is on.
   *
   * THE TOURNAMENT BREAK ENDS HERE TOO (2026-09-10). GameServer's synchronized
   * tournament break stops the same tournaments at the same :55, but it used
   * to count its own five minutes from whenever its pause loop had finished.
   * At 16:55 on 2026-09-10 that loop paused 47 tournaments one after another
   * until 16:55:18.8, so their countdown ran to about 17:00:19 and their
   * tables came back after the cash tables. It reads this instead now.
   *
   *   counting_down  the fixed end of the countdown players are watching
   *   last_hand      derived from the announcement exactly as the frame's
   *                  resume_expected_at is: the two-minute lead plus the break
   *   idle           0, there is no platform break to end with
   *
   * Read-only. Unlike remainingMs() it answers during the last hand as well,
   * because the tournament break fires at the same :55 instant as the
   * countdown and may land on either side of it.
   */
  endsAt(): number {
    if (this.phase === 'counting_down') return this.breakEndsAt;
    if (this.phase === 'last_hand') {
      return (
        this.announcedAt + MaintenanceBreak.LAST_HAND_LEAD_MS + MaintenanceBreak.BREAK_DURATION_MS
      );
    }
    return 0;
  }

  /**
   * The deploy workflow's gate, and the single most important boolean here.
   *
   * True only when the countdown is running, every table has actually reached
   * the pause gate, and enough of the break remains for a restart to finish
   * inside it. A workflow that restarts on anything less is restarting on live
   * tables again, which is where we started.
   */
  readyForRestart(): boolean {
    if (this.phase !== 'counting_down') return false;
    if (!this.durableConfirmed) return false;
    if (this.unparkedTables().length > 0) return false;
    const ready = this.remainingMs() >= MaintenanceBreak.MIN_REMAINING_FOR_RESTART_MS;
    if (ready && this.readyForRestartAtMs === null) this.readyForRestartAtMs = this.now();
    return ready;
  }

  /** Published on /health. */
  snapshot(): Record<string, unknown> {
    const unparked = this.isActive() ? this.unparkedTables() : [];
    return {
      active: this.isActive(),
      recoveryWindowProtocol: this.deps.assertRecoveryWindowContract
        ? 'engine-recovery-window-v1'
        : null,
      // The release owner must not spend its one immutable announcement while
      // the previous break is still thawing or resuming tables. The endpoint
      // rechecks this after its database contract read to close races.
      recoveryWindowReady: Boolean(
        this.startOperation &&
        this.deps.assertRecoveryWindowContract &&
        this.lifecycleIsCurrent(this.lifecycleGeneration) &&
        this.deps.isRunning() &&
        !this.isActive() &&
        !this.recoveryWindowIsBusy()
      ),
      phase: this.phase,
      durableConfirmed: this.isActive() && this.durableConfirmed,
      breakEndsAt: this.breakEndsAt > 0 ? this.breakEndsAt : null,
      remainingMs: this.remainingMs(),
      unparkedTables: unparked.length,
      // Why, not just how many: see maintenanceDurabilityReason on the engine.
      unparkedReasons: { ...this.unparkedReasonCounts },
      readyForRestart: this.readyForRestart(),
      reason: this.reason,
      resumeWaves: this.resumeWaves,
      presentation: this.presentation(),
    };
  }
}

/** FNV-1a, 32-bit. A stable key for the resume order that owes nothing to adoption order. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * `chicagoHourMinute` used to live here, to answer "is this one of the five
 * restart hours". Going hourly deleted the question, and with it the whole
 * class of DST bugs that came with answering it. Do not reintroduce a
 * timezone here: if a future change needs one, it needs a reason first.
 */
