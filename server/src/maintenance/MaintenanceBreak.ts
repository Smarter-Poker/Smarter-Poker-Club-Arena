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
 *   :00   end(). Every engine resumes on the hour, together.
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

import { setMaintenanceFrozen } from './freezeState.js';

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
  isRunning(): boolean;
}

export type MaintenanceBreakPhase = 'last_hand' | 'counting_down';

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
}

/** Durable side, so the tests can drive this without a database. */
export interface MaintenanceBreakStore {
  load(): Promise<PersistedMaintenanceBreak | null>;
  save(state: PersistedMaintenanceBreak): Promise<void>;
  clear(): Promise<void>;
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

export interface MaintenanceBreakDeps {
  /** Every live table engine, cash and tournament alike. */
  engines(): Iterable<[string, PausableTableEngine]>;
  /** False once the process is shutting down; stops any further scheduling. */
  isRunning(): boolean;
  /** Discrete per-table event frame to every subscriber of that table. */
  emit(tableId: string, payload: Record<string, unknown>): void;
  store: MaintenanceBreakStore;
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
  thaw?: (freezeStartedAtMs: number, frozenSeconds: number) => Promise<void>;
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
   * PHASE 3 (2026-09-02): the resume is staggered, not a single burst.
   *
   * resumeEveryEngine used to wake every table in one synchronous loop, so at
   * :00 all ~250 dealing loops hit a 2-core database in the same instant -
   * loading seats, blinds and stacks - which is a large part of the 10-20
   * minute recovery Dan watched ("100% of the time says reconnecting to the
   * table"). The first batch resumes immediately (so a small fleet, and every
   * test fleet, is fully up at once); the rest roll out RESUME_STAGGER_MS
   * apart. Every table still receives exactly one resumeFromMaintenance; the
   * only change is that some wake a few seconds later, gentler on the database
   * than the herd, never harsher.
   */
  static readonly RESUME_BATCH_SIZE = 25;
  static readonly RESUME_STAGGER_MS = 750;

  private phase: MaintenanceBreakPhase | 'idle' = 'idle';
  private announcedAt = 0;
  /** When counting_down began - the instant the thaw measures from. */
  private breakStartedAt = 0;
  /** PHASE 2 measurements, reset at beginCountdown, handed out at end(). */
  private unparkedAtCountdown = 0;
  private peakUnparked = 0;
  private readyForRestartAtMs: number | null = null;
  /** Bumped each break; a scheduled resume batch from a superseded break is dropped. */
  private resumeToken = 0;
  private breakEndsAt = 0;
  private reason = 'Scheduled Engine Maintenance';

  private announceTimer: NodeJS.Timeout | null = null;
  private countdownTimer: NodeJS.Timeout | null = null;
  private endTimer: NodeJS.Timeout | null = null;
  private started = false;

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
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.restoreFromStore();
    this.scheduleNextAnnouncement();
  }

  stop(): void {
    this.started = false;
    for (const t of [this.announceTimer, this.countdownTimer, this.endTimer]) {
      if (t) this.clearTimer(t);
    }
    this.announceTimer = null;
    this.countdownTimer = null;
    this.endTimer = null;
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

  private async restoreFromStore(): Promise<void> {
    let saved: PersistedMaintenanceBreak | null = null;
    let lastErr: unknown = null;
    let loaded = false;
    for (let attempt = 1; attempt <= MaintenanceBreak.RESTORE_ATTEMPTS && !loaded; attempt++) {
      try {
        saved = await this.deps.store.load();
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
        }
      }
    }
    if (!loaded) {
      // Fail OPEN, but only after the retries above. A break we cannot read
      // is a break we cannot honour, and refusing to deal because the
      // database is unhappy would turn a storage blip into a platform outage.
      console.warn(
        `[MaintenanceBreak] could not read the persisted break after ${
          MaintenanceBreak.RESTORE_ATTEMPTS
        } attempts, starting unpaused: ${(lastErr as Error)?.message ?? lastErr}`
      );
      return;
    }
    if (!saved) return;

    const remaining =
      saved.phase === 'counting_down' && saved.breakEndsAt
        ? saved.breakEndsAt - this.now()
        : MaintenanceBreak.BREAK_DURATION_MS;

    if (remaining <= 1000) {
      // Expired while we were down. Clear it so no browser keeps counting.
      await this.safeClear();
      return;
    }

    this.reason = saved.reason;
    this.announcedAt = saved.announcedAt;
    this.phase = 'counting_down';
    // The previous engine's start instant, so the thaw measures the WHOLE
    // freeze, not just the slice this process lived through.
    this.breakStartedAt = saved.breakStartedAt ?? this.now();
    this.breakEndsAt = this.now() + Math.min(remaining, MaintenanceBreak.BREAK_DURATION_MS);
    setMaintenanceFrozen(true);

    console.log(
      `[MaintenanceBreak] Resumed a break left by the previous engine - ${Math.round(
        (this.breakEndsAt - this.now()) / 1000
      )}s remaining. Parking every table until it ends.`
    );

    this.parkEveryEngine();
    this.broadcast('counting_down');
    await this.persist();
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
    if (!this.isActive()) return;
    engine.pauseForMaintenance(this.remainingParkBudgetMs());
    this.deps.emit(tableId, this.eventPayload(tableId, this.phase as MaintenanceBreakPhase));
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

    this.announceTimer = this.setTimer(() => {
      void (async () => {
        try {
          await this.announceLastHand();
        } catch (err) {
          console.error('[MaintenanceBreak] announcement failed', err);
        }
        // Re-arm from the wall clock, never from this moment.
        this.scheduleNextAnnouncement();
      })();
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
   * hour is a window now, so the only question is "when is the next :53", and
   * every zone the platform cares about is a whole number of hours off UTC, so
   * that minute is the same instant everywhere.
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
    next.setSeconds(0, 0);
    next.setMinutes(announceMinute);
    let t = next.getTime();
    // Already past this hour's mark (the common case, since we are usually
    // re-arming a moment after firing): take the next hour's.
    if (t <= now) t += 60 * 60 * 1000;
    return t - now;
  }

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
    if (!this.deps.isRunning()) return;
    if (this.isActive()) return; // already in one

    this.phase = 'last_hand';
    this.announcedAt = this.now();
    this.breakEndsAt = 0;
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

    this.broadcast('last_hand');
    await this.persist();

    if (this.countdownTimer) this.clearTimer(this.countdownTimer);
    this.countdownTimer = this.setTimer(() => {
      void this.beginCountdown().catch((err) =>
        console.error('[MaintenanceBreak] countdown failed to start', err)
      );
    }, MaintenanceBreak.LAST_HAND_LEAD_MS);
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
    if (this.phase !== 'last_hand') return;

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

    this.phase = 'counting_down';
    this.breakStartedAt = this.now();
    this.breakEndsAt = this.now() + MaintenanceBreak.BREAK_DURATION_MS;

    console.log(
      `[MaintenanceBreak] ═══ BREAK STARTED ═══ ${
        MaintenanceBreak.BREAK_DURATION_MS / 60000
      } minutes. Play resumes on the hour.`
    );

    this.broadcast('counting_down');
    await this.persist();
    this.armEndTimer();
  }

  private armEndTimer(): void {
    if (this.endTimer) this.clearTimer(this.endTimer);
    const remaining = Math.max(0, this.breakEndsAt - this.now());
    this.endTimer = this.setTimer(() => {
      void this.end().catch((err) => console.error('[MaintenanceBreak] resume failed', err));
    }, remaining);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 3 - :00, everybody plays again
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Resume every table, together, and clear the row.
   *
   * The row is cleared even if a resume throws. A stranded row is worse than a
   * stranded engine: the engine has its own safety timeout inside
   * awaitPauseGate and will deal again on its own, whereas a row nobody
   * deletes keeps every browser on the platform showing a break screen for a
   * break that ended. fn_maintenance_break_state self-expires for the same
   * reason, as a second line of defence.
   */
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
    if (this.phase === 'idle' || this.ending) return;
    this.ending = true;

    /**
     * THE THAW COMES FIRST (Dan 2026-09-01: "picks back up exactly as it
     * was"). Deadlines are shifted while every table is still parked, so no
     * clock can be judged - a sit-out evicted, a seat hold expired, a Spin
     * level rolled - in the gap between the first table resuming and the
     * shift landing. If the thaw itself fails, play still resumes: five
     * minutes of clock drift is a wrong that heals, a platform that stays
     * frozen is not.
     */
    let thawOk: boolean | null = null;
    if (this.deps.thaw && this.breakStartedAt > 0) {
      const frozenSeconds = Math.max(1, Math.round((this.now() - this.breakStartedAt) / 1000));
      try {
        await this.deps.thaw(this.breakStartedAt, frozenSeconds);
        thawOk = true;
        console.log(`[MaintenanceBreak] Thawed the platform clocks (+${frozenSeconds}s).`);
      } catch (err) {
        thawOk = false;
        console.error(
          '[MaintenanceBreak] THAW FAILED - resuming anyway; clocks lost the frozen minutes.',
          err
        );
      }
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
    /**
     * THE BREAK IS OVER BEFORE THE FIRST TABLE WAKES (review fix, 2026-09-03).
     *
     * The staggered batches (phase 3) fire RESUME_STAGGER_MS apart and each
     * one checks `this.phase === 'idle'` so a batch left over from a break
     * that has since been superseded cannot wake a table the next break is
     * holding. That check used to be satisfied only AFTER `recordOutcome`
     * resolved, and recordOutcome is a database insert made at :00 - the one
     * instant the database is guaranteed to be at its slowest (statement
     * timeouts of up to 8s are routine there). An insert slower than 750ms
     * would have dropped batch 1; one slower than 10s would have dropped all
     * fourteen batches of a 355-table fleet, and a dropped table cannot
     * recover: the pause safety timeout wakes it, the loop's own gate sees
     * `maintenancePaused` still set and parks it again, forever. The 23:55
     * restart's insert took 170ms, which is why 355 tables came back; that
     * is luck, not design. So: the break goes idle FIRST, then the tables
     * are woken. The outcome was captured above, so the record stays honest.
     */
    this.phase = 'idle';
    this.breakStartedAt = 0;
    this.breakEndsAt = 0;
    this.announcedAt = 0;
    this.ending = false;
    setMaintenanceFrozen(false);

    const resumed = this.resumeEveryEngine();
    outcome.tablesResumed = resumed;
    // The break's own scorecard line. Never allowed to delay or fail the
    // resume: the first batch is already running and the rest are scheduled
    // by the time this is awaited, and nothing below gates them.
    if (this.deps.recordOutcome) {
      try {
        await this.deps.recordOutcome(outcome);
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
    this.broadcastEnded();
    await this.safeClear();
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

  private resumeEveryEngine(): number {
    // Collect the tables this break is responsible for resuming, in order.
    const resumable: Array<[string, PausableTableEngine]> = [];
    for (const [tableId, engine] of this.deps.engines()) {
      try {
        if (this.deps.shouldStayPaused?.(tableId)) {
          console.log(
            `[MaintenanceBreak] Leaving ${tableId} paused - its tournament is still on a break of its own.`
          );
          continue;
        }
        resumable.push([tableId, engine]);
      } catch (err) {
        console.warn(`[MaintenanceBreak] could not inspect table ${tableId} for resume`, err);
      }
    }

    const token = ++this.resumeToken;
    const B = MaintenanceBreak.RESUME_BATCH_SIZE;

    const resumeOne = (tableId: string, engine: PausableTableEngine): void => {
      try {
        engine.resumeFromMaintenance();
      } catch (err) {
        // One table that refuses to resume must not strand the rest.
        console.warn(`[MaintenanceBreak] could not resume table ${tableId}`, err);
      }
    };

    // Batch 0 resumes NOW, synchronously: a small fleet (and every test fleet)
    // is fully up before end() returns, and there is no visible stagger below
    // the batch size.
    for (const [id, engine] of resumable.slice(0, B)) resumeOne(id, engine);

    // The remaining batches roll out RESUME_STAGGER_MS apart, in the
    // background. A batch from a superseded break (resumeToken changed) is
    // dropped rather than waking a table the next break is holding.
    const rest = resumable.slice(B);
    for (let i = 0; i < rest.length; i += B) {
      const batch = rest.slice(i, i + B);
      const delay = (i / B + 1) * MaintenanceBreak.RESUME_STAGGER_MS;
      this.setTimer(() => {
        // Drop a stale batch: a newer break has superseded this rollout
        // (resumeToken bumped), or a break is once again active and holding
        // these tables (phase left idle). Waking them now would deal a table
        // back into a break it is supposed to be paused in.
        if (this.resumeToken !== token || this.phase !== 'idle') return;
        for (const [id, engine] of batch) resumeOne(id, engine);
      }, delay);
    }

    // Every table in `resumable` receives exactly one resume; the count is
    // honest at call time even though the later batches wake shortly after.
    return resumable.length;
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
  private unparkedTables(): string[] {
    const out: string[] = [];
    for (const [tableId, engine] of this.deps.engines()) {
      try {
        if (!engine.isRunning()) continue;
        if (!engine.isBetweenHands()) out.push(tableId);
      } catch {
        // Unreadable engines are not counted against the gate; an engine that
        // throws on inspection is already being handled by the reapers.
      }
    }
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

  private eventPayload(tableId: string, phase: MaintenanceBreakPhase) {
    return {
      type: 'maintenance_break',
      table_id: tableId,
      phase,
      // Absolute epoch ms, not a duration. The client ticks its own countdown
      // from this so it keeps counting through the restart, when there is no
      // engine to ask and no socket to ask it on.
      break_ends_at: this.breakEndsAt > 0 ? this.breakEndsAt : null,
      duration_ms: MaintenanceBreak.BREAK_DURATION_MS,
      reason: this.reason,
      timestamp: this.now(),
    };
  }

  private broadcast(phase: MaintenanceBreakPhase): void {
    for (const [tableId] of this.deps.engines()) {
      try {
        this.deps.emit(tableId, this.eventPayload(tableId, phase));
      } catch (err) {
        console.warn(`[MaintenanceBreak] could not announce to table ${tableId}`, err);
      }
    }
  }

  private broadcastEnded(): void {
    for (const [tableId] of this.deps.engines()) {
      try {
        this.deps.emit(tableId, {
          type: 'maintenance_break_ended',
          table_id: tableId,
          timestamp: this.now(),
        });
      } catch (err) {
        console.warn(`[MaintenanceBreak] could not signal break end to table ${tableId}`, err);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Persistence
  // ─────────────────────────────────────────────────────────────────────────

  private async persist(): Promise<void> {
    if (this.phase === 'idle') return;
    try {
      await this.deps.store.save({
        phase: this.phase,
        announcedAt: this.announcedAt,
        breakStartedAt: this.breakStartedAt > 0 ? this.breakStartedAt : null,
        breakEndsAt: this.breakEndsAt > 0 ? this.breakEndsAt : null,
        reason: this.reason,
      });
    } catch (err) {
      // The break still runs in memory; only the cross-restart half is lost.
      // Loud, because that half is the point of the feature.
      console.error(
        '[MaintenanceBreak] FAILED to persist the break. The restart will be visible to players.',
        err
      );
    }
  }

  private async safeClear(): Promise<void> {
    try {
      await this.deps.store.clear();
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
   * The deploy workflow's gate, and the single most important boolean here.
   *
   * True only when the countdown is running, every table has actually reached
   * the pause gate, and enough of the break remains for a restart to finish
   * inside it. A workflow that restarts on anything less is restarting on live
   * tables again, which is where we started.
   */
  readyForRestart(): boolean {
    if (this.phase !== 'counting_down') return false;
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
      phase: this.phase,
      breakEndsAt: this.breakEndsAt > 0 ? this.breakEndsAt : null,
      remainingMs: this.remainingMs(),
      unparkedTables: unparked.length,
      readyForRestart: this.readyForRestart(),
      reason: this.reason,
    };
  }
}

/**
 * `chicagoHourMinute` used to live here, to answer "is this one of the five
 * restart hours". Going hourly deleted the question, and with it the whole
 * class of DST bugs that came with answering it. Do not reintroduce a
 * timezone here: if a future change needs one, it needs a reason first.
 */
