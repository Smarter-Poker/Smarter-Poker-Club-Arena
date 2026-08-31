/**
 * ServerTableEngine, layer 3/8 — turn timers, time bank, heartbeat, player actions.
 *
 * Split out of the 5,623-line `src/engine/ServerTableEngine.ts` monolith on
 * 2026-08-08 (every deploy tool in this pipeline caps a single file at ~50 KB).
 * Behavior is preserved line-for-line: the only edits are module boundaries,
 * `private` widened to `protected` across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import { HandController } from './HandController.js';
import {
  bettingStructureFor,
  isPotLimitVariant,
  isFixedLimitVariant,
  fixedLimitBetSize,
  isFixedLimitCapped,
  substituteOnCappedStreet,
  type BettingStructure,
} from './BettingStructure.js';
import type { HandStage, ActionType } from '../types.js';

import { HorseLogic, resolveHorseStyle } from './HorseLogic.js';
import { getTournamentBrainContext } from '../services/TournamentBrainContext.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';
import { deadlineScheduler } from './DeadlineScheduler.js';
import { ServerActionValidator } from './ServerActionValidator.js';
import { TimeBankEngine } from './TimeBankEngine.js';
import { DisconnectEngine } from './DisconnectEngine.js';
import * as EngineMetrics from '../observability/engineInstruments.js';
import type { ValidationContext } from './ServerActionValidator.js';
import { supabase } from '../services/supabase.js';
import type { HandEvent, SeatedPlayer } from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { ServerTableEngineSeating } from './ServerTableEngineSeating.js';
// Static watchdog thresholds live on the Base class (single source of truth).
import { ServerTableEngineBase } from './ServerTableEngineBase.js';
import { noteDecisionMs } from './BrainTelemetry.js';

/**
 * A monotonic millisecond clock that cannot throw.
 *
 * `performance` is global in every Node this runs on, but the measurement must
 * never be able to break a hand — a horse failing to act because a timer was
 * unavailable would be an absurd way to lose a table. Date.now() is the
 * fallback and is accurate enough for a millisecond-scale budget.
 */
function perfNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export abstract class ServerTableEngineTurns extends ServerTableEngineSeating {
  /**
   * Dan 2026-08-20: a queued pre-action (auto-check / auto-fold / auto-call)
   * used to fire synchronously at 0ms the instant the turn arrived — the seat
   * never visibly took its turn, and with several players holding pre-actions
   * a whole street resolved instantly and looked like they had been skipped.
   *
   * Shorter than a horse's think time because the player already decided, but
   * never zero: the seat lights up, holds a readable beat, and only then does
   * the action land.
   *
   * Instance field, not a static, so a test can drive pre-action ORDER without
   * spending its real-world seconds.
   */
  protected preActionVisibleMs = 900;

  // ═══════════════════════════════════════════════════════════════════════════════
  // TURN TIMER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * FAULT INJECTION — deliberately reproduce the freeze this engine's watchdog
   * exists to recover from, so recovery can be PROVEN rather than assumed.
   *
   * Every recovery path shipped on 2026-08-15 was written against a bug report
   * and unit tests. Two of them turned out to be broken in ways only a drill
   * would reveal (the watchdog could not reach its kill tier; Docker never
   * restarts unhealthy containers). Untested recovery is not recovery.
   *
   * This reproduces the precise shape the real defects produced: a seat that is
   * the current actor, with NO clock armed and no pending action. The watchdog
   * should notice within one heartbeat and re-arm the clock (Tier 1).
   *
   * Returns a description of what was broken, for the drill log. Callers are
   * responsible for the safety gate — see handlers/faultInjection.ts, which
   * refuses to run when any human is seated.
   */
  injectTurnStall(): {
    tableId: string;
    seat: number;
    hadClock: boolean;
    hadHorseTimer: boolean;
    handNumber: number;
  } {
    const state = this.handController?.getState();
    const seat = state?.currentPlayerSeat ?? -1;
    const player = state?.players.find((p) => p.seat === seat);
    const hadClock = player ? this.preciseTimer.hasTimer(this.tableId, player.user_id) : false;
    const hadHorseTimer = !!this.horseActionTimer;

    // 1. Kill the clock — this is what every real freeze had in common.
    this.preciseTimer.clearTable(this.tableId);
    // 1b. Suppress the pending horse action too. Removing only the enforcement
    //     clock is NOT a freeze: the horse's think-time timer still fires and
    //     the table carries on, which is exactly what the first drill showed.
    //     A real freeze is "nobody is going to act AND no clock will force it".
    if (this.horseActionTimer) {
      clearTimeout(this.horseActionTimer);
      this.horseActionTimer = null;
    }
    // 2. Backdate progress past the stall threshold so the next heartbeat trips
    //    the watchdog immediately rather than after a 45s wait.
    this.lastProgressAtMs = Date.now() - (ServerTableEngineBase.WATCHDOG_STALL_MS + 5_000);
    this.watchdogTrips = 0;

    console.warn(
      `[ServerTableEngine:${this.tableId}] FAULT INJECTED: turn stall at seat ${seat} ` +
        `(clock removed, progress backdated). Watchdog should recover this.`
    );
    return { tableId: this.tableId, seat, hadClock, hadHorseTimer, handNumber: this.handCount };
  }

  /**
   * Cancel every turn deadline this table owns.
   *
   * 2026-08-15: this was an EMPTY FUNCTION with a comment explaining that the
   * work happened elsewhere. Four call sites believed it cancelled timers and
   * none of them did anything:
   *   - ServerTableEngineBase.stop()            (engine teardown)
   *   - ServerTableEngineDealing HAND_COMPLETE  (hand cleanup)
   *   - ServerTableEngineRunout                 ("pause all timers during the
   *                                              insurance/RIT decision window")
   *   - ServerTableEngineTurns handlePlayerAction
   * The runout case is the one that bit: the engine believed it had paused the
   * clock for an insurance offer and had not, so a seat could be auto-folded
   * mid-offer by a timer nobody thought was still armed.
   *
   * preciseTimer.clearTable cancels only the `turn:<playerId>` entries this
   * class owns — it deliberately leaves the heartbeat and the TimeBankEngine's
   * separate `timebank:<playerId>` deadlines alone.
   */
  /** V14: how far into an auto-granted time bank a horse may tank. The bank
   *  grants ~20s per use, so this leaves a wide safety margin against the
   *  bank expiring and auto-folding the hand. */
  private static readonly HORSE_MAX_BANK_BURN_MS = 9000;

  protected clearTurnTimer(): void {
    this.preciseTimer.clearTable(this.tableId);
    // V13: this function's own doc says "every turn deadline this table owns",
    // and it left the horse's think timer armed. injectTurnStall right above
    // already clears both, for exactly this reason. The exposed caller is the
    // insurance/RIT runout pause: currentPlayerSeat is not necessarily cleared
    // there, so a think timer armed before the pause could fire an action INTO
    // the paused window — the same class of bug this function was written to
    // fix, reintroduced for the other timer.
    if (this.horseActionTimer) {
      clearTimeout(this.horseActionTimer);
      this.horseActionTimer = null;
    }
  }

  /**
   * Last-resort clock. Depends on nothing but the seat and the timer, so it
   * still works when the normal turn-change path has thrown partway through.
   */
  protected forceArmTurnTimer(seat: number, seconds: number): void {
    const p = this.seatedPlayers.find((sp) => sp.seat_number === seat);
    if (!p) return;
    this.startTurnTimer(p.user_id, seat, seconds);
  }

  /**
   * TABLE WATCHDOG (Dan 2026-08-15: "the game keeps freezing... this will
   * literally kill any users from joining or playing with us").
   *
   * Before this existed the engine had NO liveness check of any kind — the only
   * signal was `isRunning()`, a boolean that cannot go false when the loop dies.
   * On 2026-08-15 that let ten cash tables (including Dan's own NLH 2/5, hand
   * #1320) sit frozen at preflop for 18+ minutes with funded seats, invisible to
   * discovery.
   *
   * Every freeze this recovers from is a bug somewhere else. The watchdog exists
   * so that such a bug costs ONE HAND rather than a table. It escalates and
   * never touches chips directly:
   *   Tier 1  the seat simply lost its clock         -> give it one back
   *   Tier 2  still stalled                          -> force check-if-free/fold,
   *                                                     which restarts the whole
   *                                                     event cascade
   *   Tier 3  unrecoverable in-process               -> kill the engine so
   *                                                     GameServer rebuilds it
   * Runs on the 10s heartbeat tick.
   */
  protected override runTableWatchdog(): void {
    const idleMs = this.msSinceProgress();

    // A table paused ON PURPOSE (hand-for-hand / FSM 'paused') is healthy no
    // matter how long it has been idle. Killing it here is what used to deal
    // a hand INTO hand-for-hand after the rebuild lost the pause flag. If the
    // pause outlives any plausible coordination window, report it loudly —
    // once per window, never a kill: forcing play during a legitimate pause
    // is a tournament-integrity failure, a long pause is only an incident.
    if (this.isPausedByDesign()) {
      const pausedMs = this.msPaused();
      if (
        pausedMs > ServerTableEngineBase.PAUSE_ALARM_MS &&
        Date.now() - this.lastPauseAlarmAtMs > ServerTableEngineBase.PAUSE_ALARM_MS
      ) {
        this.lastPauseAlarmAtMs = Date.now();
        reportError(
          new Error(
            'Table paused-by-design for ' +
              Math.round(pausedMs / 60000) +
              'min - hand-for-hand/break coordinator may have lost the resume signal'
          ),
          'ServerTableEngine.' + this.tableId + '.paused_too_long',
          { handCount: this.handCount }
        );
        this.recordRecoveryEvent(
          'paused_too_long',
          'paused ' + Math.round(pausedMs / 1000) + 's without resume'
        );
      }
      return;
    }

    // Case B: no live hand, but the table is dealable and nothing is starting.
    if (!this.handController) {
      // Mirror dealingLoop's own activePlayers predicate exactly, so the
      // watchdog's idea of "this table should be dealing" cannot disagree
      // with the loop's. A table where everyone is sitting out is idle by
      // design and must not be restarted.
      const dealable = this.seatedPlayers.filter(
        (p) =>
          p.stack > 0 &&
          // Tournament sit-outs are dealt in (blind-off) — the watchdog must
          // agree with the dealing loop or it would restart an "idle" table.
          (this.isTournamentTable() ||
            !this.disconnectEngine.isSittingOut(this.tableId, p.user_id)) &&
          !this.waitingForBB.has(p.user_id)
      ).length;
      if (dealable >= this.minPlayersToDeal() && idleMs > ServerTableEngineBase.WATCHDOG_IDLE_MS) {
        /**
         * ── Dan 2026-08-22: "games randomly break, stop running or freeze" ──
         *
         * This branch used to read "no hand has started for 90s" as "the
         * dealing loop is dead". Those are not the same statement, and the
         * live fleet proved it: 1,603 kills in six hours, EVERY running cash
         * table killed 22-30 times, each after an average of three hands.
         * hand_history shows the shape exactly — normal 8-45s hand spacing,
         * then 107s, 107s, 114s, 87s: two 90s trips plus a rebuild, forever,
         * on fully funded tables with nothing wrong with them.
         *
         * The between-hands path is five Supabase round trips, none of which
         * marked progress. Database slowness is CORRELATED across tables, so
         * one slow minute stalled the whole fleet at once, killed every engine
         * at once, and the rebuild storm then loaded the database harder than
         * the slowness that started it. The watchdog was the engine of the
         * outage it was built to prevent.
         *
         * So ask the loop, not the calendar. `msSinceLoopPhase()` is the time
         * since the loop last MOVED. Wedged in one step is a dead loop and is
         * killed as before, now naming the step it died in. Still cycling is
         * an alive loop: it gets the five-minute horizon and, if it really
         * never deals, a kill under its own name rather than this one.
         */
        const loopWedged = this.msSinceLoopPhase() > ServerTableEngineBase.WATCHDOG_IDLE_MS;
        if (!loopWedged && idleMs <= ServerTableEngineBase.WATCHDOG_LOOP_ALIVE_IDLE_MS) return;

        this.watchdogTrips++;
        reportError(
          new Error(
            'Table idle ' +
              Math.round(idleMs / 1000) +
              's with ' +
              dealable +
              ' dealable seats - dealing loop ' +
              (loopWedged ? 'is wedged at ' : 'is cycling without dealing, at ') +
              this.describeLoopPhase()
          ),
          'ServerTableEngine.' + this.tableId + '.watchdog_loop_dead',
          {
            handCount: this.handCount,
            trips: this.watchdogTrips,
            loopPhase: this.loopPhase,
            loopPhaseMs: this.msSinceLoopPhase(),
          }
        );
        // The phase goes in the kill reason, so `engine_recovery_events.detail`
        // names the cause instead of repeating the symptom. Phase only, never
        // the elapsed seconds — a detail that is unique per row cannot be
        // grouped, and grouping is the entire point of recording it.
        if (this.watchdogTrips >= 2) {
          this.killForRestart(
            (loopWedged ? 'dealing_loop_dead' : 'loop_ticking_no_hands') + ':' + this.loopPhase
          );
        }
      }
      return;
    }

    if (idleMs <= ServerTableEngineBase.WATCHDOG_STALL_MS) return;

    const state = this.handController.getState();
    const seat = state.currentPlayerSeat;

    if (seat < 0) {
      // No actionable seat and no runout continuation fired. Finish the hand
      // rather than wait out the 10-minute safety void.
      this.watchdogTrips++;
      reportError(
        new Error(
          'Hand #' +
            this.handCount +
            ' stalled ' +
            Math.round(idleMs / 1000) +
            's with no current seat'
        ),
        'ServerTableEngine.' + this.tableId + '.watchdog_no_seat'
      );
      try {
        (this.handController as any).continueRunout?.();
      } catch {
        /* fall through to the kill tier */
      }
      if (this.watchdogTrips >= 3) this.killForRestart('stalled_no_seat');
      return;
    }

    const p = state.players.find((x) => x.seat === seat);
    if (!p) {
      // currentPlayerSeat points at a seat that is not in the hand state. There
      // is nothing to re-arm and nothing to force — bailing silently here would
      // make the watchdog a no-op forever. Escalate straight to a rebuild.
      this.watchdogTrips++;
      reportError(
        new Error('Watchdog: currentPlayerSeat ' + seat + ' is not present in hand state'),
        'ServerTableEngine.' + this.tableId + '.watchdog_seat_missing'
      );
      if (this.watchdogTrips >= 3) this.killForRestart('current_seat_not_in_state');
      return;
    }
    // PreciseActionTimer keys on user_id (SeatPlayer.user_id in types.ts) — an
    // `id`/`userId` guess would always miss and pin the watchdog at Tier 1.
    const hasClock = this.preciseTimer.hasTimer(this.tableId, p.user_id);
    this.watchdogTrips++;

    reportError(
      new Error(
        'Hand #' +
          this.handCount +
          ' stalled ' +
          Math.round(idleMs / 1000) +
          's at seat ' +
          seat +
          ' (clock=' +
          hasClock +
          ', stage=' +
          state.stage +
          ', trip=' +
          this.watchdogTrips +
          ')'
      ),
      'ServerTableEngine.' + this.tableId + '.watchdog_turn_stalled'
    );

    if (this.watchdogTrips === 1 && !hasClock) {
      this.forceArmTurnTimer(seat, this.tableInfo?.action_time_seconds || 15);
      this.recordRecoveryEvent(
        'watchdog_rearm_clock',
        'seat ' + seat + ' had no clock after ' + Math.round(idleMs / 1000) + 's; re-armed'
      );
      // Handing the seat a clock IS the recovery — restart the stall window so
      // the next heartbeat (10s away) does not force a fold 7s before the 15s
      // clock we just granted would have expired. Deliberately NOT
      // markProgress(): that zeroes watchdogTrips, which would let Tier 1
      // re-arm forever and never escalate.
      this.lastProgressAtMs = Date.now();
      return;
    }

    if (this.watchdogTrips <= 3) {
      // Cancel any orphaned time-bank deadline for this seat first: forcing an
      // action outside handlePlayerAction leaves `timebank:<uid>` armed, and a
      // per-table turn FSM means that orphan can later steal a DIFFERENT seat's
      // time-bank expiry and suppress its auto-fold.
      try {
        this.timeBankEngine.playerActed(this.tableId, p.user_id);
      } catch {
        /* best-effort */
      }
      const toCall = Math.max(0, (state.currentBet || 0) - (p.bet || 0));
      const forced = toCall === 0 ? 'check' : 'fold';
      let applied = false;
      try {
        applied = this.handController.performAction(seat, forced as any);
        if (!applied) applied = this.handController.performAction(seat, 'fold' as any);
      } catch (err) {
        reportError(err, 'ServerTableEngine.' + this.tableId + '.watchdog_force_action_failed');
      }
      // CRITICAL: markProgress() also zeroes watchdogTrips. Calling it after a
      // REJECTED force (the exact state a stale currentPlayerSeat produces)
      // reset the escalation ladder every cycle, so Tier 3 — the kill-and-
      // rebuild this whole watchdog exists to reach — was unreachable and the
      // table stayed frozen forever while logging a stall every 45s.
      if (applied) {
        this.recordRecoveryEvent(
          'watchdog_forced_action',
          'forced ' +
            forced +
            ' at seat ' +
            seat +
            ' after ' +
            Math.round(idleMs / 1000) +
            's stall'
        );
        this.markProgress();
      } else {
        reportError(
          new Error('Watchdog forced action REJECTED at seat ' + seat + ' - escalating to rebuild'),
          'ServerTableEngine.' + this.tableId + '.watchdog_force_rejected'
        );
      }
      return;
    }

    this.killForRestart('turn_unrecoverable');
  }

  /**
   * Resolve a seat that MUST stop being on the clock, preferring check over
   * fold (Bible V8 §1.7.4). Returns false only when the engine refuses both.
   *
   * 2026-08-15: HandController.performAction RETURNS FALSE on an illegal
   * action — it does not throw. Every call site that wrapped it in try/catch
   * and trusted the catch was silently doing nothing when the action was
   * rejected, leaving a seat with no clock and no action: a permanent freeze.
   * This helper is the single correct way to force a seat, so the bug cannot
   * be reintroduced one call site at a time.
   */
  protected forceResolveSeat(seat: number, preferCheck: boolean): boolean {
    if (!this.handController) return false;
    const order: Array<'check' | 'fold'> = preferCheck ? ['check', 'fold'] : ['fold'];
    for (const a of order) {
      try {
        if (this.handController.performAction(seat, a as any)) return true;
      } catch (err) {
        reportError(err, 'ServerTableEngine.' + this.tableId + '.force_' + a + '_threw');
      }
    }
    return false;
  }

  protected startTurnTimer(userId: string, seat: number, durationSeconds: number): void {
    // Deliberately does NOT call clearTurnTimer(). Now that clearTurnTimer
    // actually cancels every turn deadline on the table, calling it on each
    // re-arm would wipe the deadline this method is about to set — and
    // startTurnTimer is re-entered by the time-bank auto-activation path
    // moments after a timer is armed. PreciseActionTimer.startTimer already
    // cancels any existing deadline for the same (table, player) key, so the
    // re-arm is idempotent without it.
    // NOTE: Do NOT reset timeBankActivatedThisTurn here — this method is also called
    // from activateTimeBank() to extend the timer. The flag is reset in handleTurnChange()
    // when a genuinely new turn begins.
    this.playerTurnStartTime = Date.now();
    this.playerTurnDuration = Math.max(0, durationSeconds);

    // Bible V8 §2.15: Log timer start
    this.currentHandTimerLog.push({
      playerId: userId,
      event: 'timer_start',
      timestamp: Date.now(),
      durationMs: durationSeconds * 1000,
    });

    // Safety fallback: if no duration, default to 15s to prevent infinite loops
    const safeDurationSeconds = this.playerTurnDuration > 0 ? this.playerTurnDuration : 15;

    // Phase 1.2: Register with PreciseActionTimer — this is now the SOLE timer.
    // The auto-fold/check logic runs as the onExpiry callback via DeadlineScheduler.
    // Bible V8 §6.1: 2-second grace period for network latency is baked into the
    // timer duration so the scheduler fires after the grace window.
    const GRACE_PERIOD_MS = 2000;
    const totalDurationMs = safeDurationSeconds * 1000 + GRACE_PERIOD_MS;

    // ── Law 1.16 `timer_countdown` (roadmap batch 6, 2026-08-21) ─────────
    // Authoritative countdown pulses at fixed thresholds of the DISPLAY
    // deadline (start + duration, no grace - the same deadline the snapshot
    // publishes as turn_deadline_ms), so clients can pin their ticking to
    // the engine's clock instead of deriving it. Idempotent per table via
    // eventId; thresholds beyond this turn's length are explicitly
    // cancelled so a longer previous turn cannot leak a stale pulse. Each
    // callback re-checks the turn identity (start stamp + seat) before
    // emitting, and a stale fire is a silent no-op.
    const displayDeadlineMs = this.playerTurnStartTime + safeDurationSeconds * 1000;
    const countdownStartStamp = this.playerTurnStartTime;
    const COUNTDOWN_THRESHOLDS_MS = [10_000, 5_000, 3_000, 2_000, 1_000];
    for (const thresholdMs of COUNTDOWN_THRESHOLDS_MS) {
      const eventId = `timer_countdown:${thresholdMs}`;
      const fireAtMs = displayDeadlineMs - thresholdMs;
      if (fireAtMs <= Date.now()) {
        deadlineScheduler.cancel(this.tableId, eventId);
        continue;
      }
      deadlineScheduler.schedule({
        tableId: this.tableId,
        eventId,
        deadlineMs: fireAtMs,
        callback: () => {
          if (!this.running || !this.handController) return;
          if (this.playerTurnStartTime !== countdownStartStamp) return; // newer turn owns the clock
          const cdState = this.handController.getState();
          if (cdState.currentPlayerSeat !== seat) return;
          try {
            this.hub?.emitEvent(this.tableId, {
              type: 'timer_countdown',
              table_id: this.tableId,
              player_id: userId,
              seat,
              remaining_ms: Math.max(0, displayDeadlineMs - Date.now()),
              timestamp: Date.now(),
            });
          } catch {
            /* broadcast failure is non-fatal */
          }
        },
      });
    }

    this.preciseTimer.startTimer(this.tableId, userId, totalDurationMs, () => {
      // === onExpiry callback — fires when DeadlineScheduler tick reaches deadline ===
      if (!this.running || !this.handController) return;

      const state = this.handController.getState();
      if (state.currentPlayerSeat !== seat) return;

      // Bible V8 §6.2: Auto-activate time bank when primary timer expires
      // FIX: Guard against race condition where the player already submitted an action
      // and the FSM advanced to 'processing' or 'complete' before this timer callback fired.
      // Only attempt time bank auto-activation if the turn is still in 'timer_running'.
      // timeBankSuppressedThisTurn: the player dropped out of reconnect grace
      // during THIS turn. Falling through to onPrimaryTimerExpired here would
      // auto-activate (and, use-it-or-lose-it, fully spend) a bank they cannot
      // use. Skipping it leaves the ordinary deadline to resolve the seat
      // exactly as it would have anyway.
      if (
        !this.timeBankActivatedThisTurn &&
        !this.timeBankSuppressedThisTurn &&
        this.turnFSM.state === 'timer_running'
      ) {
        const autoActivated = this.timeBankEngine.onPrimaryTimerExpired(
          this.tableId,
          userId,
          () => {
            // Time bank itself expired — auto-fold/check
            // Bible V8 §3.3: Turn FSM — time_bank_active → expired → processing → complete
            // Guard: only transition if we're still in time_bank_active
            // 2026-08-15: turnFSM is PER TABLE, not per seat. An orphaned
            // timebank deadline (left behind by a watchdog force-action, a
            // disconnect auto-action or a reconnect re-arm) could fire while a
            // DIFFERENT seat was legitimately in time_bank_active, consume that
            // seat's FSM transitions and then bail — after which the real
            // seat's own expiry failed this guard and never folded, leaving the
            // pool-sized turn clock as the only enforcement.
            //
            // Seat identity is checked FIRST and is authoritative; the FSM is
            // advisory. A seat that is still the current player when its time
            // bank expires MUST be resolved, whatever the FSM says.
            if (!this.running || !this.handController) return;
            const tbState = this.handController.getState();
            if (tbState.currentPlayerSeat !== seat) return;
            if (this.turnFSM.state === 'time_bank_active') {
              this.turnFSM.transition('expired');
              this.turnFSM.transition('processing');
            } else {
              console.warn(
                `[ServerTableEngine:${this.tableId}] Time bank expiry: FSM in '${this.turnFSM.state}' but seat ${seat} is still current - resolving anyway`
              );
            }

            const tbPlayer = tbState.players.find((p) => p.seat === seat);
            const tbToCall = tbPlayer ? Math.max(0, tbState.currentBet - (tbPlayer.bet ?? 0)) : 0;
            const tbCanCheck = tbToCall === 0;

            console.warn(
              `[ServerTableEngine:${this.tableId}] Player ${userId} time bank expired. ` +
                (tbCanCheck ? 'Auto-checking.' : 'Auto-folding.')
            );
            if (this.forceResolveSeat(seat, tbCanCheck)) {
              this.markProgress();
            } else {
              reportError(
                new Error('Time bank auto-action rejected at seat ' + seat + ' - re-arming clock'),
                'ServerTableEngine.' + this.tableId + '.timebank_auto_action_rejected'
              );
              this.forceArmTurnTimer(seat, this.tableInfo?.action_time_seconds || 15);
            }

            // Bible V8 §3.3: Turn FSM — processing → complete
            this.turnFSM.transition('complete');

            // AUDIT FIX 2026-08-21: the 2026-07-19 fix added strike counting to
            // the PLAIN timer-expiry path only. But an AFK player with time-bank
            // uses left never reaches that path — the bank auto-activates and
            // expiry resolves HERE instead, so consecutiveTimeouts stayed at 0
            // forever and the player burned a full time bank every single hand
            // without ever being sat out (observed live: one player's timers
            // grinding at four stale tables at once). A time-bank expiry is a
            // timeout too — count it toward the auto-sit-out cap.
            this.disconnectEngine.recordConnectedTimeout(this.tableId, userId);

            this.engineTelemetry.recordTimerExpired(this.tableId);
            const tbUsesLeft = this.timeBankEngine.getUsesRemaining(this.tableId, userId);
            try {
              this.hub?.emitEvent(this.tableId, {
                type: 'time_bank_timeout',
                table_id: this.tableId,
                player_id: userId,
                uses_remaining: tbUsesLeft,
                timed_out_action: tbCanCheck ? 'check' : 'fold',
                show_buy_more: tbUsesLeft <= 0,
              });
            } catch {
              /* broadcast failure is non-fatal */
            }
          }
        );

        if (autoActivated) {
          // Bible V8 §3.3: Turn FSM — timer_running → time_bank_active
          // FIX: Double-check FSM state before transitioning — another callback may have
          // advanced it to 'processing' between the outer guard and here (tight race window).
          if (this.turnFSM.state !== 'timer_running') {
            console.warn(
              `[ServerTableEngine:${this.tableId}] Time bank auto-activation skipped - FSM is '${this.turnFSM.state}' (expected timer_running). Turn already resolved.`
            );
            return;
          }
          this.turnFSM.transition('time_bank_active');
          this.timeBankActivatedThisTurn = true;
          // Bible V8 §2.15: Log time bank activation
          this.currentHandTimerLog.push({
            playerId: userId,
            event: 'time_bank_activated',
            timestamp: Date.now(),
            timeBankUsed: true,
          });
          // 2026-08-15: this used getRemainingSeconds() — the whole remaining
          // POOL (max_uses x 15s, i.e. 60s on every production table today, and
          // 1800s on the engine's own default config), not the 15s that
          // TimeBankEngine.activate() just armed. Two consequences: the
          // enforcement deadline (15s) disagreed with the turn timer, and
          // startTurnTimer stamps playerTurnDuration, which is what
          // turn_deadline_ms broadcasts — so the CLIENT was told it had 60
          // seconds and then auto-folded at 15. The manual activateTimeBank
          // path already reads currentUseSeconds correctly; this was the outlier.
          const bank = this.timeBankEngine.getPlayerBank(this.tableId, userId);
          // Bible V8 §6.2: a bank grants 20s. The 15 that used to be the
          // fallback here is the DECISION clock, a different number.
          const grantedSeconds = bank?.currentUseSeconds ?? 20;
          const usesAfterActivation = this.timeBankEngine.getUsesRemaining(this.tableId, userId);
          console.log(
            `[ServerTableEngine:${this.tableId}] Auto-activated time bank for ${userId} (${grantedSeconds}s granted, ${usesAfterActivation} uses left)`
          );
          // Restart turn timer with the granted time bank duration
          this.startTurnTimer(userId, seat, grantedSeconds);

          // Broadcast time bank activation to other players
          try {
            supabase
              .channel(`table:${this.tableId}`)
              .send({
                type: 'broadcast',
                event: 'time_bank_activated',
                payload: {
                  player_id: userId,
                  table_id: this.tableId,
                  // The seconds actually granted for THIS use, matching the
                  // enforcement deadline. Broadcasting the whole pool told the
                  // client it had far longer than the clock would allow.
                  additional_seconds: grantedSeconds,
                  auto_activated: true,
                  uses_remaining: usesAfterActivation,
                },
              })
              .catch(() => {});
          } catch {
            /* broadcast failure is non-fatal */
          }

          // FIX 125 + 2026-04-14 spam fix: warn ONLY at the last 1 remaining
          // and at 0 (the very last one was just used). Was firing at <=5
          // which on a 4-max-uses table means every single use triggered the
          // warning. Tester reported "after every card" spam.
          if (usesAfterActivation >= 0 && usesAfterActivation <= 1) {
            try {
              this.hub?.emitEvent(this.tableId, {
                type: 'time_bank_low',
                table_id: this.tableId,
                player_id: userId,
                uses_remaining: usesAfterActivation,
              });
            } catch {
              /* broadcast failure is non-fatal */
            }
          }

          return; // Time bank activated — don't auto-fold/check yet
        }
      }

      // No time bank available — auto-fold or auto-check
      // Bible V8 §2.15: Log timer expiry
      this.currentHandTimerLog.push({
        playerId: userId,
        event: 'timer_expired',
        timestamp: Date.now(),
      });
      // Bible V8 §3.3: Turn FSM — timer_running → expired → processing
      this.turnFSM.transition('expired');
      this.turnFSM.transition('processing');
      const player = state.players.find((p) => p.seat === seat);
      const amountToCall = player ? Math.max(0, state.currentBet - (player.bet ?? 0)) : 0;
      const canCheck = amountToCall === 0;

      console.warn(
        `[ServerTableEngine:${this.tableId}] Player ${userId} timed out. ` +
          (canCheck ? 'Auto-checking (no bet to call).' : `Auto-folding (${amountToCall} to call).`)
      );
      // By the time this callback runs the PreciseActionTimer entry has already
      // fired and been dropped. If the forced action is REJECTED the seat is
      // left with no clock and no action while the FSM below records it as
      // resolved — a terminal freeze. Re-arm rather than pretend it resolved.
      if (this.forceResolveSeat(seat, canCheck)) {
        this.markProgress();
      } else {
        reportError(
          new Error('Timeout auto-action rejected at seat ' + seat + ' - re-arming clock'),
          'ServerTableEngine.' + this.tableId + '.auto_action_rejected'
        );
        this.forceArmTurnTimer(seat, this.tableInfo?.action_time_seconds || 15);
      }

      // Bible V8 §3.3: Turn FSM — processing → complete
      this.turnFSM.transition('complete');

      // AUDIT FIX 2026-07-19: count this timeout for a CONNECTED player so an
      // AFK player is auto-sat-out after the cap (was only counted on the
      // disconnect path — an app-open-but-idle player never got sat out).
      this.disconnectEngine.recordConnectedTimeout(this.tableId, userId);

      this.engineTelemetry.recordTimerExpired(this.tableId);
      const usesLeft = this.timeBankEngine.getUsesRemaining(this.tableId, userId);
      try {
        this.hub?.emitEvent(this.tableId, {
          type: 'time_bank_timeout',
          table_id: this.tableId,
          player_id: userId,
          uses_remaining: usesLeft,
          timed_out_action: canCheck ? 'check' : 'fold',
          show_buy_more: usesLeft <= 0,
        });
      } catch {
        /* broadcast failure is non-fatal */
      }
    });
  }

  /**
   * Activate Time Bank triggered by the client HTTP POST to `/timebank`
   * Bible V8 §6.2: Manual activate — delegates to TimeBankEngine (single source of truth)
   */
  public async activateTimeBank(
    userId: string
  ): Promise<{ success: boolean; error?: string; armed?: boolean; message?: string }> {
    // CLAUDE.md §5.7: every one of these strings reaches the player as a toast,
    // so they are Title Case with no em dashes.
    if (!this.handController || !this.tableInfo) {
      return { success: false, error: 'No Active Hand At This Table' };
    }

    const state = this.handController.getState();
    const player = state.players.find((p) => p.user_id === userId);

    /* THE DISCARD IS A DECISION, SO IT CAN BUY TIME (2026-08-31).
       Everything below this line is written against `currentPlayerSeat`, and
       the Crazy Pineapple discard round has no turn - every seat decides at
       once - so the press landed on "Not Your Turn", and the one action most
       likely to make a player hesitate was the only one on the table with no
       way to think. Missing it folds the hand outright.

       Routed to the round's own per-seat deadline, which applies the same
       exhaustion rule, the same pool and the same per-street cap as a turn. */
    if (state.stage === 'pineapple_discard') {
      return this.extendPineappleDiscard(userId);
    }

    if (!player || state.currentPlayerSeat !== player.seat) {
      return { success: false, error: 'Not Your Turn' };
    }

    if (this.timeBankActivatedThisTurn) {
      return { success: false, error: 'Your Time Bank Is Already Running' };
    }

    // Bible V8 §6.2: Check via TimeBankEngine (single source of truth for pool + per-street limits)
    if (!this.timeBankEngine.hasTimeBank(this.tableId, userId)) {
      // VIP time banks 2026-08-17: a diamond top-up purchased mid-session
      // lives only in the DB. Refresh once before rejecting, then re-validate
      // the turn - the await may have raced the action.
      const refreshed = await this.refreshTimeBankFromDb(userId);
      if (!refreshed || !this.timeBankEngine.hasTimeBank(this.tableId, userId)) {
        return { success: false, error: 'No Time Bank Uses Remaining' };
      }
      const stateAfter = this.handController?.getState();
      if (!stateAfter || stateAfter.currentPlayerSeat !== player.seat) {
        return { success: false, error: 'Not Your Turn' };
      }
      if (this.timeBankActivatedThisTurn) {
        return { success: false, error: 'Your Time Bank Is Already Running' };
      }
    }

    // How much ordinary turn clock is still on the board.
    //
    // Dan 2026-08-23, binding: "It should not take a time bank or add more time
    // until you have truly used your entire 15 seconds." So this is no longer
    // an amount to stack the bank on top of — it is the EXHAUSTION TEST. While
    // it is above the epsilon the press costs nothing and grants nothing; it
    // only records the intent, which onPrimaryTimerExpired redeems the instant
    // the clock actually runs out.
    //
    // Captured BEFORE the engine call so the check and the timer armed further
    // down are derived from the same instant.
    const remainingBeforeBank = Math.max(
      0,
      this.playerTurnDuration - (Date.now() - this.playerTurnStartTime) / 1000
    );

    if (remainingBeforeBank > TimeBankEngine.CLOCK_EXHAUSTED_EPSILON_SECONDS) {
      if (!this.timeBankEngine.arm(this.tableId, userId)) {
        return { success: false, error: 'No Time Bank Uses Remaining' };
      }
      console.log(
        `[ServerTableEngine:${this.tableId}] Player ${userId} armed a time bank with ${Math.round(remainingBeforeBank)}s still on the clock. Nothing spent yet.`
      );
      return {
        success: true,
        armed: true,
        message: 'Time Bank Armed. It Starts When Your Clock Runs Out',
      };
    }

    // Activate via TimeBankEngine — it handles pool depletion, the per-street
    // limit, the exhaustion check and event emission.
    const activation = this.timeBankEngine.tryActivate(
      this.tableId,
      userId,
      () => {
        // This callback fires when the manual time bank expires
        if (!this.running || !this.handController) return;
        const tbState = this.handController.getState();
        if (tbState.currentPlayerSeat !== player.seat) return;

        const tbPlayer = tbState.players.find((p) => p.seat === player.seat);
        const tbToCall = tbPlayer ? Math.max(0, tbState.currentBet - (tbPlayer.bet ?? 0)) : 0;
        const tbCanCheck = tbToCall === 0;

        // performAction returns FALSE on an illegal action - it does not throw
        // (see the doc block on forceResolveSeat). The previous try/catch here
        // therefore never reached its fold fallback: a rejected `check` left the
        // seat with no action, no re-armed clock and no markProgress, hanging
        // the hand until the stall watchdog. forceResolveSeat is the path the
        // AUTO time-bank expiry already uses; this was the last site that had
        // not been migrated to it.
        if (this.forceResolveSeat(player.seat, tbCanCheck)) {
          this.markProgress();
        } else {
          reportError(
            new Error(
              'Manual time bank auto-action rejected at seat ' + player.seat + ' - re-arming clock'
            ),
            'ServerTableEngine.' + this.tableId + '.manual_timebank_auto_action_rejected'
          );
          this.forceArmTurnTimer(player.seat, this.tableInfo?.action_time_seconds || 15);
        }

        // FIX 149: Wire telemetry — manual time bank expiry
        this.engineTelemetry.recordTimerExpired(this.tableId);

        // FIX 124c: Manual time bank expired → broadcast timeout event (same as FIX 124b for auto path)
        const tbUsesLeft = this.timeBankEngine.getUsesRemaining(this.tableId, userId);
        try {
          this.hub?.emitEvent(this.tableId, {
            type: 'time_bank_timeout',
            table_id: this.tableId,
            player_id: userId,
            uses_remaining: tbUsesLeft,
            timed_out_action: tbCanCheck ? 'check' : 'fold',
            show_buy_more: tbUsesLeft <= 0,
          });
        } catch {
          /* broadcast failure is non-fatal */
        }
      },
      remainingBeforeBank
    );

    if (activation !== 'activated') {
      // Title Case, no em dashes (CLAUDE.md §5.7). Each reason is distinct so
      // the player is not told "depleted" when they simply used both banks on
      // this street and still own plenty.
      const reason =
        activation === 'street_limit'
          ? 'You Have Already Used Two Time Banks On This Street'
          : activation === 'already_active'
            ? 'Your Time Bank Is Already Running'
            : activation === 'clock_not_exhausted'
              ? 'Your Clock Is Still Running'
              : 'No Time Bank Uses Remaining';
      return { success: false, error: reason };
    }

    this.timeBankActivatedThisTurn = true;

    // Get bank info for the broadcast
    const bank = this.timeBankEngine.getPlayerBank(this.tableId, userId);
    const bankSeconds = bank ? bank.currentUseSeconds : 20;

    // A bank RESETS the clock; it does not extend it. remainingBeforeBank is
    // within the exhaustion epsilon by the time we get here, so there is
    // nothing left to add and the enforcement countdown armed inside
    // TimeBankEngine is this same number.
    const newDuration = bankSeconds;

    console.log(
      `[ServerTableEngine:${this.tableId}] Player ${userId} spent a time bank. Clock reset to ${bankSeconds}s.`
    );

    this.startTurnTimer(userId, player.seat, newDuration);

    // Broadcast time bank activation to other players
    try {
      supabase
        .channel(`table:${this.tableId}`)
        .send({
          type: 'broadcast',
          event: 'time_bank_activated',
          payload: {
            player_id: userId,
            table_id: this.tableId,
            additional_seconds: bankSeconds,
            uses_remaining: bank?.usesRemaining ?? 0,
            total_remaining: bank?.remainingSeconds ?? 0,
            auto_activated: false,
          },
        })
        .catch((err) => reportError(err, 'ServerTableEngine.time_bank_broadcast_failed'));
    } catch (err) {
      // A cosmetic broadcast must never break the turn it decorates — but it
      // must not vanish either. This was the one bare `catch (e) {}` left in
      // the engine: an unused binding, no comment, no report, swallowing every
      // synchronous throw from the legacy Realtime path.
      reportError(err, 'ServerTableEngine.time_bank_broadcast_threw');
    }

    // FIX 125 + 2026-04-14 spam fix: warn ONLY at the last 1 remaining (or 0
    // = just used last one). Previous <=5 condition spammed on 4-max tables.
    const manualUsesLeft = bank?.usesRemaining ?? 0;
    if (manualUsesLeft >= 0 && manualUsesLeft <= 1) {
      try {
        this.hub?.emitEvent(this.tableId, {
          type: 'time_bank_low',
          table_id: this.tableId,
          player_id: userId,
          uses_remaining: manualUsesLeft,
        });
      } catch {
        /* broadcast failure is non-fatal */
      }
    }

    // Phase X5 (2026-04-29) — Bible V8 §1.16 time_bank_activated public event
    // distinct from time_bank_low/timeout. Broadcast lets opponents see the
    // "TIMEBANK" indicator on the acting player's seat ring (not just the
    // hero who triggered it).
    try {
      this.hub?.emitEvent(this.tableId, {
        type: 'time_bank_activated',
        table_id: this.tableId,
        player_id: userId,
        seat: player.seat,
        uses_remaining: manualUsesLeft,
        // Dan 2026-08-21 (item 2): the client extends its countdown from this
        // number. Without it the hub path fell back to a hard-coded default,
        // so a bank of any other length was displayed wrong.
        secondsGranted: bankSeconds,
        usesRemaining: manualUsesLeft,
        timestamp: Date.now(),
      });
    } catch {
      /* broadcast failure is non-fatal */
    }

    return { success: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // MISSING ENDPOINTS — Bible V8 Required (heartbeat, preaction, sitout, state)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * POST /heartbeat — Bible V8 §6.3: Reset disconnect timer for a player
   */
  public heartbeat(
    userId: string,
    /**
     * PHASE 2 (2026-08-31): the client reporting that it has actually DRAWN
     * the action controls for this player. Optional - older clients omit it,
     * and the silent-client canary falls back to its weaker signal rather
     * than treating them as suspect.
     *
     * It rides the heartbeat instead of getting a route of its own because
     * the heartbeat already runs on a timer, is already authenticated, and
     * already resolves the table engine. A second endpoint would be a second
     * thing to keep alive for the sake of one boolean.
     */
    opts?: { turnRendered?: boolean }
  ): {
    success: boolean;
    connected: boolean;
    gracePeriodRemaining: number;
  } {
    this.disconnectEngine.heartbeat(this.tableId, userId);
    if (opts?.turnRendered) {
      this.disconnectEngine.noteTurnRendered(this.tableId, userId);
    }
    const connected = this.disconnectEngine.isConnected(this.tableId, userId);
    return { success: true, connected, gracePeriodRemaining: 0 };
  }

  /**
   * CONNECTIVITY UPGRADE (2026-08-22): transport-level disconnect signal.
   * Called by EngineWebSocketServer when a player's LAST live socket for this
   * table closes. Millisecond-latency counterpart to the 30s stale-heartbeat
   * sweep: the disconnect countdown / auto-action ladder starts immediately
   * instead of the table burning a full action clock on a player who is gone.
   * A reconnect (WS onConnect -> heartbeat) cancels it just as fast.
   */
  /**
   * POST /away — Dan 2026-08-23: the CLIENT is telling us it is going away
   * (pagehide, tab close, app frozen by the OS), rather than us inferring it
   * from silence.
   *
   * That distinction is why this skips the transport grace window that
   * `notifyTransportDisconnect` opens: a socket dying is ambiguous, but "I am
   * leaving" is not. The player keeps their seat — they are simply AWAY, so
   * the one-SB-one-BB cap applies and they are stood up and cashed out once
   * it is spent. Coming back (any heartbeat) clears it at no cost.
   */
  public notifyPageLeft(userId: string): void {
    this.disconnectEngine.markPageLeft(this.tableId, userId);
  }

  public notifyTransportDisconnect(userId: string): void {
    // 2026-08-22: markTransportGone, not markDisconnected. The socket dying is
    // not the player leaving — their HTTP heartbeat is a second transport, and
    // concluding on the first one alone fired a disconnect banner, a sound and
    // a haptic buzz at players who never went anywhere.
    this.disconnectEngine.markTransportGone(this.tableId, userId);
  }

  /**
   * POST /preaction — Bible V8 §4.15: Set or clear a pre-action
   *
   * ── THE ARM IS ACKNOWLEDGED WITH THE ENGINE'S OWN NUMBER (2026-08-30) ────
   *
   * The response now carries `armedToCall`: the price the ENGINE recorded at
   * set time (`toCallAtSet`), computed from its own authoritative state.
   *
   * Why this matters, and why it is not a broadcast. The client suppresses
   * the ActionPanel while an armed pre-action is one the engine can still
   * honour (src/lib/preActionPanelGate.ts), and until now it judged that
   * against a price IT snapshotted in the browser at the moment of the tap.
   * Two independent snapshots of the same number, taken at two moments, on
   * two machines — they agree almost always, and the "almost" is a player
   * seeing the panel flash on a hand where the engine was going to act, or
   * (worse) not seeing it on a hand where the engine had already invalidated
   * the arm. Handing back the engine's number collapses that to ONE number.
   *
   * It is returned in the reply to the hero's OWN request, so no other seat
   * learns anything: this is deliberately not the table-wide broadcast that
   * would hand villains the tell the engine's visible pre-action beat exists
   * to mask.
   */
  public setPreAction(
    userId: string,
    action: string,
    maxCallAmount?: number
  ): { success: boolean; error?: string; armedToCall?: number } {
    if (!this.handController) {
      return { success: false, error: 'No active hand' };
    }
    const state = this.handController.getState();
    const player = state.players.find((p) => p.user_id === userId);
    if (!player) {
      return { success: false, error: 'Player not found at this table' };
    }

    if (action === 'clear') {
      this.preActionEngine.clearPreAction(this.tableId, userId);
      return { success: true };
    }

    // Validate the pre-action type
    const validPreActions = [
      'auto_fold',
      'auto_check_fold',
      'auto_check',
      'auto_call',
      'auto_call_any',
    ];
    if (!validPreActions.includes(action)) {
      return { success: false, error: `Invalid pre-action: ${action}` };
    }

    /**
     * Dan 2026-08-28 (CRITICAL): record the price the player is looking at
     * RIGHT NOW, computed by the engine from its own authoritative state —
     * never trusted from the client. PreActionEngine invalidates an
     * `auto_call` whose price has risen past this by the time it fires, so
     * "Call 15" can never call a raise to more than 15 even when the client
     * sends no maxCallAmount at all.
     */
    const toCallAtSet = Math.max(0, state.currentBet - (player.bet ?? 0));
    this.preActionEngine.setPreAction(
      this.tableId,
      userId,
      action as any,
      maxCallAmount,
      toCallAtSet
    );

    // LIVE E2E FIX 2026-08-15: a pre-action armed AFTER the player's turn had
    // already started used to sit queued until their NEXT turn — the only
    // execution hook was handleTurnChange step 1, which had already run. Live
    // repro: hero armed CALL ANY as a bet landed and the turn began; nothing
    // fired and the turn timer ran. Real poker rooms convert the armed
    // pre-action into an immediate action in that case. If it is currently
    // this player's turn and they can still act, resolve the pre-action now
    // and route it through the normal serialized action path
    // (handlePlayerAction: validation, lock, timer clear, broadcast).
    if (
      player.seat === state.currentPlayerSeat &&
      !player.is_folded &&
      !player.is_all_in &&
      !player.is_sitting_out
    ) {
      const toCall = Math.max(0, state.currentBet - (player.bet ?? 0));
      const preResult = this.preActionEngine.executePreAction(
        this.tableId,
        userId,
        toCall === 0,
        toCall,
        player.stack
      );
      if (preResult.executed && preResult.action) {
        const acted = this.handlePlayerAction(userId, preResult.action, preResult.amount);
        if (acted.success) {
          console.log(
            `[ServerTableEngine:${this.tableId}] Pre-action armed mid-turn executed immediately: ${userId} -> ${preResult.action}${preResult.amount ? ` ${preResult.amount}` : ''}`
          );
        } else {
          console.warn(
            `[ServerTableEngine:${this.tableId}] Immediate pre-action ${preResult.action} rejected: ${acted.error}`
          );
        }
      }
    }

    /* The engine's own recorded price rides back to the hero (see the note on
       this method). One number, not two snapshots that can disagree. */
    return { success: true, armedToCall: toCallAtSet };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // REAL PLAYER ACTION — Accept actions from HTTP endpoint
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Handle an action from a REAL player (not a horse).
   * Called from the HTTP /action endpoint when a player clicks fold/call/raise.
   */
  handlePlayerAction(
    userId: string,
    action: string,
    amount?: number
  ): { success: boolean; error?: string; code?: string; hint?: Record<string, unknown> } {
    // Bible V8 §1.1.4: Serialize all actions — no parallel processing
    if (this.actionLock) {
      return { success: false, error: 'Action already being processed - try again' };
    }
    this.actionLock = true;
    try {
      return this._handlePlayerActionInner(userId, action, amount);
    } finally {
      this.actionLock = false;
    }
  }

  protected _handlePlayerActionInner(
    userId: string,
    action: string,
    amount?: number
  ): { success: boolean; error?: string; code?: string; hint?: Record<string, unknown> } {
    if (!this.handController) {
      return { success: false, error: 'No active hand' };
    }

    const state = this.handController.getState();

    // Find the player's seat
    const player = state.players.find((p) => p.user_id === userId);
    if (!player) {
      return { success: false, error: 'Player not found at this table' };
    }

    // Verify it's this player's turn
    if (state.currentPlayerSeat !== player.seat) {
      return { success: false, error: 'Not your turn' };
    }

    // AUDIT FIX 2026-07-19: the player is present and acting — clear any
    // consecutive-timeout streak so a single AFK lapse doesn't accumulate
    // toward an auto-sit-out.
    this.disconnectEngine.recordPlayerActed(this.tableId, userId);

    const seat = player.seat;
    const toCall = Math.max(0, state.currentBet - player.bet);

    // Normalize actions
    let normalizedAction = action.toLowerCase();
    if (normalizedAction === 'allin' || normalizedAction === 'all-in') normalizedAction = 'all_in';
    if (normalizedAction === 'check' && toCall > 0) normalizedAction = 'call';
    if (normalizedAction === 'call' && toCall === 0) normalizedAction = 'check';
    if (normalizedAction === 'raise' && state.currentBet === 0) normalizedAction = 'bet';
    if (normalizedAction === 'bet' && state.currentBet > 0) normalizedAction = 'raise';

    // Bible V8 §4.14: PLO variants are pot-limit; flh/flo8 are fixed-limit
    // (2026-08-23). BettingStructure decides — this used to be an inline
    // `startsWith('plo')`, which silently made every non-PLO variant no-limit.
    // VARIANT OVERRIDE FOLLOW-UP 2026-08-28: read the LIVE HAND's variant, not
    // the table row. `activeHandVariant()` was introduced the same day for
    // exactly this, and its docblock names "the legal-action clamps in Turns"
    // as one of the four sites that must use it — getLegalActions (1512) and
    // the horse snapshot (1887) were converted, THIS clamp and its horse twin
    // below were missed. On a bomb-pot hand whose override differs from the
    // table's variant that mismatch is silent and expensive: a PLO table with
    // an nlh override clamped a player's shove down to the pot, and a
    // fixed-limit table with an nlh override REWROTE the wager to the table's
    // limit size — in both cases the player was committed to an amount they
    // never chose. The reverse (NLH table, PLO bomb) enforced no pot ceiling
    // here at all and left HandController to reject the action, burning the
    // player's clock on "Action rejected by engine".
    const variant = this.activeHandVariant();
    const isPotLimit = isPotLimitVariant(variant);
    const isFixedLimit = isFixedLimitVariant(variant);
    let potLimitMaxBet = Infinity;
    if (isPotLimit) {
      // FIX 142: Pot-limit max raise SIZE = pot + toCall (the pot after you call).
      // Previous formula (pot + toCall + toCall) was one toCall too permissive.
      // For a BET (toCall=0): maxBet = pot. For a RAISE: maxRaiseSize = pot + toCall.
      // This matches PokerEngine.calculateBettingState (FIX 121).
      potLimitMaxBet = state.pot + toCall;
    }

    // Fixed limit has exactly one legal wager size per street, so a client that
    // sends any other number is SNAPPED to it rather than rejected — a limit
    // client has no slider to be wrong with, and an old client sending a
    // no-limit sizing should still make a legal bet. Small bet preflop and
    // flop, big bet turn and river.
    const flBetSize = isFixedLimit
      ? fixedLimitBetSize(this.tableInfo?.big_blind ?? 2, state.stage)
      : 0;

    /**
     * ── CAP: A PER-HAND CEILING ON WHAT A PLAYER CAN PUT IN ────────────────
     *
     * Dan 2026-08-25, table-creation parity. `cap_enabled` has been a toggle
     * since February with NO AMOUNT COLUMN ANYWHERE IN THE SCHEMA, so even a
     * reader could not have enforced it. `cap_bb` was added alongside this.
     *
     * A cap is a limit on TOTAL chips committed across the whole hand, not on
     * one street, so it is measured against `totalInvested` — which the engine
     * already maintains and broadcasts. `player.bet` is this street only, and
     * capping on that would let a player commit the cap four times over.
     *
     * CLAMPED, NOT REJECTED, exactly like the pot-limit ceiling above it and
     * for the same reason the fixed-limit snap gives: a client with a stale
     * cap value should still make a LEGAL bet rather than have its action
     * bounce. The amount is reduced to whatever is left under the ceiling.
     *
     * A player who reaches the cap is NOT all-in — their remaining stack stays
     * in front of them and plays the next hand. That is the whole point of a
     * cap game, and it is why the all-in promotions below have to be measured
     * against the capped figure rather than the raw stack.
     */
    const capBB = Number(this.tableInfo?.cap_bb) || 0;
    const capChips =
      this.tableInfo?.cap_enabled === true && capBB > 0
        ? capBB * (Number(this.tableInfo?.big_blind) || 0)
        : 0;
    /* What this player may still commit this hand. Infinity when uncapped, so
       every Math.min below is a no-op on an ordinary table. */
    const capRemaining =
      capChips > 0 ? Math.max(0, capChips - (Number(player.totalInvested) || 0)) : Infinity;

    /**
     * AN "ALL IN" AT A CAPPED TABLE IS NOT ALL OF YOUR CHIPS.
     *
     * `all_in` skips the amount clamps below entirely — validateAllIn returns
     * `sanitizedAmount: context.playerStack` unconditionally — so without this
     * a player could push their whole stack past a ceiling the host set, and
     * the cap would hold for every action EXCEPT the largest one.
     *
     * Rewritten into an ordinary bet or raise of exactly what the cap leaves,
     * so it goes through the same validation as any other sized action and
     * the remainder of the stack stays in front of the player.
     */
    if (normalizedAction === 'all_in' && capRemaining !== Infinity) {
      const stillAllowed = Math.min(player.stack, capRemaining);
      if (stillAllowed <= 0) {
        return { success: false, error: "You have committed this table's cap for this hand" };
      }
      if (stillAllowed < player.stack) {
        normalizedAction = state.currentBet > 0 ? 'raise' : 'bet';
        amount = state.currentBet > 0 ? player.bet + stillAllowed : stillAllowed;
      }
    }

    // Clamp amounts
    /**
     * A CALL IS DELIBERATELY NOT CAPPED, and it does not need to be.
     *
     * Clamping a call would produce a SHORT call — an under-call that the pot
     * logic has to turn into a side pot — which is a genuine pot-integrity
     * hazard for a feature no live table has switched on. It is also
     * unnecessary, because the cap is a per-player TOTAL and every wager that
     * can be called has already been clamped above:
     *
     *   a caller's total after calling = the bettor's total for this hand,
     *   the bettor's total is <= the cap by construction,
     *   therefore the caller's total is <= the cap.
     *
     * A player can never call their way past a ceiling that every bet in front
     * of them already respects.
     */
    if (normalizedAction === 'call') amount = toCall;
    if (normalizedAction === 'bet' && amount !== undefined) {
      amount = isFixedLimit ? flBetSize : Math.max(state.minRaise, amount);
      // Bible V8 §4.14: Cap at pot-limit max for PLO
      if (isPotLimit) {
        amount = Math.min(amount, potLimitMaxBet);
      }
      // Table cap: never more than this hand has left under the ceiling.
      amount = Math.min(amount, capRemaining);
      /* CAP FIX 2026-08-27: this used to promote to all_in whenever the amount
         reached min(stack, capRemaining) — so a bet CLAMPED BY THE CAP one
         line above was immediately turned back into an all-in, and
         HandController.performAction ignores `amount` for all_in and commits
         the ENTIRE stack (`this.state.pot += player.stack; player.stack = 0`).
         The rewrite at the top of this method was therefore a no-op round
         trip and the ceiling was defeated by the largest action it exists to
         bound. Only the STACK may promote: the player is all-in when they
         have no chips left, not when the cap says stop. */
      if (amount >= player.stack && player.stack <= capRemaining) {
        normalizedAction = 'all_in';
        amount = undefined;
      }
    } else if (normalizedAction === 'raise' && amount !== undefined) {
      const minRaiseTo = state.currentBet + state.minRaise;
      amount = isFixedLimit ? state.currentBet + flBetSize : Math.max(minRaiseTo, amount);

      // Bible V8 §4.14: Cap at pot-limit max for PLO (raise TO = currentBet + potLimitMaxBet)
      if (isPotLimit) {
        const potLimitRaiseTo = state.currentBet + potLimitMaxBet;
        amount = Math.min(amount, potLimitRaiseTo);
      }
      /* A raise is a TO figure, so the ceiling has to be expressed the same
         way: this street's bet plus whatever the cap leaves. */
      const capRaiseTo = capRemaining === Infinity ? Infinity : player.bet + capRemaining;
      amount = Math.min(amount, capRaiseTo);
      /* CAP FIX 2026-08-27: same defect on the raise path — a raise clamped to
         capRaiseTo reached maxRaiseTo and was promoted to a whole-stack shove.
         The stack must be the binding constraint for an all-in; when the cap
         is what bounds the wager it stays a sized raise. */
      const stackRaiseTo = player.stack + player.bet;
      const maxRaiseTo = Math.min(stackRaiseTo, capRaiseTo);
      if (amount >= maxRaiseTo && stackRaiseTo <= capRaiseTo) {
        normalizedAction = 'all_in';
        amount = undefined;
      }
    }

    // Step 4: Run ServerActionValidator for timing, duplicate suppression, and state validation
    const currentPlayer = state.players.find((p) => p.seat === state.currentPlayerSeat);
    const validationCtx: ValidationContext = {
      currentPlayerId: currentPlayer?.user_id ?? '',
      stage: state.stage,
      currentBet: state.currentBet,
      playerBet: player.bet,
      playerStack: player.stack,
      bigBlind: this.tableInfo?.big_blind ?? 2,
      minRaise: state.minRaise,
      pot: state.pot,
      canCheck: toCall === 0,
      actionDeadline: this.preciseTimer.getDeadline(this.tableId, userId),
      playerActedThisRound: false,
      isAllIn: player.is_all_in,
      isFolded: player.is_folded,
      numActivePlayers: state.players.filter((p) => !p.is_folded && !p.is_all_in).length,
    };

    const validation = this.actionValidator.validate(
      {
        tableId: this.tableId,
        handId: `${this.handCount}`,
        playerId: userId,
        action: normalizedAction as any,
        amount,
        timestamp: Date.now(),
      },
      validationCtx
    );

    if (!validation.valid) {
      return {
        success: false,
        error: validation.reason || 'Action validation failed',
        code: validation.code,
        hint: validation.hint as Record<string, unknown> | undefined,
      };
    }

    // Use sanitized action/amount from validator if provided
    if (validation.sanitizedAction) {
      normalizedAction = validation.sanitizedAction;
    }
    if (validation.sanitizedAmount !== undefined) {
      amount = validation.sanitizedAmount;
    }

    try {
      // Bible V8 §2.15: Log action received
      this.currentHandTimerLog.push({
        playerId: userId,
        event: 'action_received',
        timestamp: Date.now(),
        durationMs: Date.now() - this.playerTurnStartTime,
        timeBankUsed: this.timeBankActivatedThisTurn,
      });
      // Bible V8 §3.3: Turn FSM — timer_running/time_bank_active → action_received → processing
      this.turnFSM.transition('action_received');
      this.turnFSM.transition('processing');

      this.clearTurnTimer();
      this.preciseTimer.cancelTimer(this.tableId, userId); // Step 4: Cancel precise deadline
      // Bible V8 §6.2: If time bank was active, notify engine to deduct used time from pool.
      //
      // 2026-08-26: this was gated on timeBankActivatedThisTurn ALONE. The
      // ARM-ONLY branch of activateTimeBank returns early - with the message
      // "Time Bank Armed. It Starts When Your Clock Runs Out" - and never sets
      // that flag, because nothing has been spent yet. So a player who pressed
      // the button early and then acted inside their ordinary clock left
      // bank.armed = true behind them. On any LATER turn in the same street,
      // onPrimaryTimerExpired sees that stale intent and spends a use they did
      // not ask for; only resetStreetActivations cleared it, a whole street
      // later. playerActed is the thing that clears bank.armed, and
      // TimeBankEngine.manualcountdown.test.ts already pins that contract
      // ("player acted in time; the intent dies with it"). The engine was
      // right; this caller simply never reached it.
      if (this.timeBankActivatedThisTurn || this.timeBankEngine.isArmed(this.tableId, userId)) {
        this.timeBankEngine.playerActed(this.tableId, userId);
      }
      const actionApplied = this.handController.performAction(
        seat,
        normalizedAction as any,
        amount
      );
      // SWEEP #4 FIX (2026-07-23): performAction returns false (it does NOT throw)
      // when the engine rejects an action the validator let through — most reachably
      // a `raise` that cannot legally reopen betting against a sub-full-raise all-in
      // (HandController §4.14 canReopenBetting). The old code ignored the false return,
      // transitioned the FSM to 'complete', and returned success — but the turn/precise
      // timers were already cancelled above and no TURN_CHANGE fired, so the table froze
      // with no clock until the 10-minute HAND_SAFETY_TIMEOUT void (and the acting client
      // was told the action succeeded). Re-arm this player's turn and surface the rejection.
      if (!actionApplied) {
        console.warn(
          `[ServerTableEngine:${this.tableId}] Engine REJECTED action ${normalizedAction} from ${userId} - re-arming turn timer`
        );
        this.rearmTurnTimerIfCurrent(userId);
        return { success: false, error: 'Action rejected by engine', code: 'INVALID_ACTION' };
      }
      console.log(
        `[ServerTableEngine:${this.tableId}] Player ${userId} → ${normalizedAction}${amount ? ` ${amount}` : ''}`
      );

      // Bible V8 §3.3: Turn FSM — processing → complete
      this.turnFSM.transition('complete');

      // FIX 149: Wire telemetry — record that player acted within timer
      this.engineTelemetry.recordTimerActed(this.tableId);

      // ── ADDITIVE observability (#5): actions-processed counter + act→broadcast timer start ──
      try {
        EngineMetrics.actionsTotal.inc(1, { table_id: this.tableId });
        this.lastActionAcceptedAtMs = Date.now();
      } catch {
        /* metrics must never affect gameplay */
      }

      // FIX 137: Bible V8 §7.17 — snapshot hand state after a successful action.
      // C15: coalesced (see requestSnapshot). This used to be an unconditional
      // write per action; a busy street now collapses to about one write per
      // second per table, and the last state of the burst is still the one that
      // lands.
      this.requestSnapshot();

      return { success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Action failed';
      console.warn(`[ServerTableEngine:${this.tableId}] Player action failed:`, errMsg);
      // ── ADDITIVE observability (#5): RPC/action error counter ──
      try {
        EngineMetrics.rpcErrorsTotal.inc(1, { method: 'action' });
      } catch {
        /* metrics must never affect gameplay */
      }
      // Return error to client — do NOT auto-fold. The player should see the error
      // and choose their next action. Auto-folding on invalid actions silently
      // destroys hands (e.g., a raise with wrong amount shouldn't fold the player).
      return { success: false, error: errMsg };
    }
  }

  /**
   * Get available actions for a specific player
   */
  getPlayerActions(userId: string): {
    canAct: boolean;
    actions: string[];
    toCall: number;
    minRaise: number;
    maxRaise: number;
    pot: number;
    /**
     * 2026-08-23: which betting structure the client should render. Without
     * this the client had to re-derive it from the variant string, which is
     * how `flh` would have drawn a no-limit slider on a fixed-limit table.
     */
    structure?: BettingStructure;
    /** Fixed limit only: the street's one legal wager size. */
    betSize?: number;
  } {
    const defaultResult = {
      canAct: false,
      actions: [],
      toCall: 0,
      minRaise: 0,
      maxRaise: 0,
      pot: 0,
    };
    if (!this.handController) return defaultResult;

    const state = this.handController.getState();
    const player = state.players.find((p) => p.user_id === userId);
    if (!player) return defaultResult;

    if (state.currentPlayerSeat !== player.seat) {
      return { ...defaultResult, pot: state.pot };
    }

    const toCall = Math.max(0, state.currentBet - player.bet);
    const actions: string[] = [];

    if (toCall > 0) {
      actions.push('fold', 'call');
      if (player.stack > toCall) actions.push('raise');
    } else {
      actions.push('check');
      if (player.stack > 0) actions.push('bet');
    }
    actions.push('all_in');

    let minRaiseTo = state.currentBet > 0 ? state.currentBet + state.minRaise : state.minRaise;
    let maxRaiseTo = player.stack + player.bet;

    // FIX 176: Bible V8 §4.14: Cap maxRaise for pot-limit games (PLO variants)
    // Pot-limit max raise SIZE = pot + toCall (the pot after you call).
    // Raise TO = currentBet + (pot + toCall). The old formula had an extra toCall
    // which allowed raises ~toCall higher than legal pot-limit max.
    // VARIANT OVERRIDE 2026-08-28: the LIVE hand's variant — the pot-limit
    // clamp must bind on a PLO bomb hand even at an NLH table.
    const variant = this.activeHandVariant();
    const structure = bettingStructureFor(variant);
    let betSize: number | undefined;
    if (structure === 'pot_limit') {
      const potLimitMaxBet = state.pot + toCall;
      const potLimitRaiseTo = state.currentBet + potLimitMaxBet;
      maxRaiseTo = Math.min(maxRaiseTo, potLimitRaiseTo);
    } else if (structure === 'fixed_limit') {
      // 2026-08-23: min and max collapse onto the same number — the client has
      // no slider to draw, only a "Bet 4" / "Raise to 8" button. Reporting the
      // stack as maxRaise here is what would have let a limit table render a
      // no-limit slider and then have every drag rejected.
      betSize = fixedLimitBetSize(this.tableInfo?.big_blind ?? 2, state.stage);
      const wagerTo = state.currentBet + betSize;
      minRaiseTo = Math.min(wagerTo, maxRaiseTo);
      maxRaiseTo = minRaiseTo;
    }

    return {
      canAct: true,
      actions,
      toCall,
      minRaise: minRaiseTo,
      maxRaise: maxRaiseTo,
      pot: state.pot,
      structure,
      betSize,
    };
  }

  /**
   * Handle horse AI turn — INSTANT decisions, no browser timers needed
   */
  /**
   * The player whose turn it is has dropped out of reconnect grace.
   *
   * WHAT THIS FIXES, and it is narrower than it first looks. The harm in a
   * mid-turn drop is not the ordinary action clock — that is the player's own
   * clock, running the length it always runs. The harm is the TIME BANK.
   * onPrimaryTimerExpired auto-activates a bank whenever the table is
   * configured to (or the player armed one before dropping), and TimeBankEngine
   * is use-it-or-lose-it: playerActed deducts the FULL currentUseSeconds
   * regardless of how much was consumed. So a player whose socket died at
   * second 9 silently spends a paid-for bank on a decision they could not make,
   * every single hand, until their pool is empty.
   *
   * So this suppresses the bank for the remainder of this turn and stops.
   *
   * WHAT THIS DELIBERATELY DOES NOT DO, because the first cut of this fix
   * (PR #1009) did all three and each one was a regression:
   *
   *   1. It does not re-stamp playerTurnStartTime / playerTurnDuration.
   *      Those two fields ARE turn_deadline_ms (ServerTableEngine:393). Setting
   *      them to `Date.now()` + disconnectTimeoutSeconds hands a player 14
   *      seconds into a 15-second clock a FRESH 30 seconds — so pulling your
   *      own network cable becomes a repeatable way to buy roughly 39s of stall
   *      on every decision. ReconnectTimeBank.test.ts exists because that exact
   *      re-stamp was already caught and closed on the reconnect path; doing it
   *      on the disconnect path is the same bug wearing the other shoe.
   *
   *   2. It does not start a disconnect countdown. onPlayerTurn's countdown is
   *      disconnectTimeoutSeconds (30) — LONGER than the 15s clock already
   *      armed — so it cannot make the table resolve sooner, and running it
   *      alongside the live turn timer means two deadlines racing to act on one
   *      seat. The existing timer already auto-folds AND records the strike
   *      (recordConnectedTimeout, line ~588/~728), which is the whole of what
   *      the disconnect path would have contributed.
   *
   *   3. It does not cancel the running bank countdown behind TimeBankEngine's
   *      back. If a bank is genuinely ACTIVE its deadline is the one in force
   *      and its expiry handler is what resolves the seat; cancelling the raw
   *      `timebank:<uid>` PreciseActionTimer key while leaving bank.isActive
   *      true strands the accounting.
   *
   * The governing principle is the one already written into
   * rearmTurnTimerIfCurrent: losing your connection must not buy you more time,
   * and must not lose you any either.
   */
  protected handlePlayerDisconnectedMidTurn(userId: string): void {
    if (!this.handController) return;
    const state = this.handController.getState();
    const player = state.players.find((p) => p.user_id === userId);
    if (!player || player.seat !== state.currentPlayerSeat) return;
    if (player.is_folded || player.is_all_in || player.is_sitting_out) return;

    // A bank that is already counting down is already spent, and its own
    // expiry handler owns this seat. Leave it strictly alone.
    const activeBank = this.timeBankEngine.getPlayerBank(this.tableId, userId);
    if (activeBank?.isActive) return;

    // An armed-but-unredeemed intent dies with the decision it was made for.
    if (this.timeBankEngine.isArmed(this.tableId, userId)) {
      this.timeBankEngine.disarm(this.tableId, userId);
    }

    this.timeBankSuppressedThisTurn = true;

    console.log(
      `[ServerTableEngine:${this.tableId}] Player ${userId} dropped mid-turn. ` +
        `Time bank suppressed for this turn; action clock left untouched.`
    );
  }

  /**
   * AUDIT FIX 2026-07-19: re-arm the action timer when a player reconnects on
   * their own turn (the disconnect countdown was cancelled with no replacement
   * timer). No-op unless a hand is live and it's genuinely this player's turn.
   */
  protected rearmTurnTimerIfCurrent(userId: string): void {
    if (!this.handController) return;
    const state = this.handController.getState();
    const player = state.players.find((p) => p.user_id === userId);
    if (!player || player.seat !== state.currentPlayerSeat) return;
    if (player.is_folded || player.is_all_in || player.is_sitting_out) return;

    // Bible V8 §1.7.5 — the reconnect grace re-arms the ACTION CLOCK, but it
    // must not also hand back the TIME BANK.
    //
    // handleTurnChange() clears timeBankActivatedThisTurn (see "Reset anti-spam
    // lock for this NEW turn" at the end of that method) because it assumes a
    // genuinely new turn. A reconnect is the SAME turn. Left alone, a player
    // could go stale, reconnect, and collect a fresh action clock AND a fresh
    // time bank on every cycle — stretching a single turn to roughly 45-55s,
    // stopped only by the unrelated table stall watchdog.
    //
    // The clock re-arm itself is deliberately preserved: removing it would
    // reintroduce the bug AUDIT FIX 2026-07-19 closed, where a reconnecting
    // player had no timer at all and the hand hung to the 10-minute void.
    // 2026-08-18 — the same "two deadlines, the shorter one wins" bug that
    // §6.2.d closed for the manual button, on the path that fix did not cover.
    //
    // If a time bank is already RUNNING for this seat, `timebank:<uid>` is
    // counting down to a deadline that startTurnTimer cannot see: it is a
    // different PreciseActionTimer key, so re-arming the turn clock replaces
    // `<uid>` and leaves the bank countdown untouched. handleTurnChange then
    // re-stamps playerTurnStartTime, which is what turn_deadline_ms broadcasts,
    // so the client is told it has a fresh clock while the older, shorter bank
    // deadline is still armed underneath and folds them mid-countdown. A tab
    // that suspends on mobile and wakes three seconds before the bank expires
    // is shown twenty seconds and folded in three.
    //
    // The player already spent the bank; reconnecting must not buy more time
    // and must not lose them any either. Leaving both the countdown AND the
    // broadcast stamps exactly as activation set them keeps the two in
    // agreement and tells the client the truth. There is a live timer here by
    // definition, so the hang this method exists to prevent cannot occur.
    const activeBank = this.timeBankEngine.getPlayerBank(this.tableId, userId);
    if (activeBank?.isActive) return;

    const timeBankAlreadyUsedThisTurn = this.timeBankActivatedThisTurn;
    // handleTurnChange is async. Calling it bare left a rejection unhandled and
    // - worse - left this seat with no clock at all, which is the precise hang
    // this method was added to prevent. The other call site
    // (ServerTableEngineHandEvents, "void this.handleTurnChange(...).catch")
    // has had the guard since it went async; this one never got it.
    void this.handleTurnChange(
      { type: 'TURN_CHANGE', seat: player.seat, availableActions: [] } as HandEvent,
      this.seatedPlayers
    ).catch((err) => {
      reportError(err, 'ServerTableEngine.' + this.tableId + '.rearm_turn_change_threw');
      this.forceArmTurnTimer(player.seat, this.tableInfo?.action_time_seconds || 15);
    });

    this.timeBankActivatedThisTurn = timeBankAlreadyUsedThisTurn;
  }

  /**
   * Dan 2026-08-20: async because a queued pre-action now holds a visible beat
   * before it lands (see preActionVisibleMs). Callers treat this as
   * fire-and-forget — the clock it arms and the pre-action it may execute are
   * both self-contained — so the one call site voids the promise and keeps its
   * existing try/catch + forceArmTurnTimer fallback for a synchronous throw.
   */
  protected async handleTurnChange(event: HandEvent, players: SeatedPlayer[]): Promise<void> {
    if (event.type !== 'TURN_CHANGE' || !this.handController) return;

    const seat = event.seat;
    const player = players.find((p) => p.seat_number === seat);
    if (!player) return;

    const state = this.handController.getState();
    const enginePlayer = state.players.find((p) => p.seat === seat);
    if (!enginePlayer) return;

    // STALE-HANDLER GUARD (2026-08-22), defense in depth with the caller's
    // check in ServerTableEngineHandEvents: never arm a clock or run
    // disconnect/pre-action logic for a seat that is no longer on the clock.
    if (state.currentPlayerSeat !== seat) return;

    // ═══════════════════════════════════════════════════════════════════════
    // UNIFIED TURN HANDLING — Horses and real players follow the EXACT same flow.
    // Bible V8: Horses MUST be indistinguishable from real players.
    // Same timer, same broadcast, same action path. NO EXCEPTIONS.
    // ═══════════════════════════════════════════════════════════════════════

    const actionTime = this.tableInfo?.action_time_seconds || 15;
    this.timeBankActivatedThisTurn = false; // Reset anti-spam lock for this NEW turn
    // A new turn (and a reconnect re-arm, which routes through here) always
    // restores normal time-bank behaviour.
    this.timeBankSuppressedThisTurn = false;

    // Bible V8 §3.3: Turn FSM — reset to waiting at turn start, then transition to timer_running
    if (this.turnFSM.state !== 'waiting') {
      this.turnFSM.forceState('waiting');
    }

    // Step 1: Check for queued pre-action before starting timer (applies to ALL players)
    const toCallForPreAction = Math.max(0, state.currentBet - enginePlayer.bet);
    const canCheckForPreAction = toCallForPreAction === 0;
    const preResult = this.preActionEngine.executePreAction(
      this.tableId,
      player.user_id,
      canCheckForPreAction,
      toCallForPreAction,
      enginePlayer.stack
    );
    if (preResult.executed && preResult.action) {
      // The `return` below skips Step 4 (startTurnTimer) entirely, so it may
      // ONLY be taken when the action genuinely landed. performAction returns
      // false on rejection (a pre-action resolved against a bet level the
      // engine then re-validates is the reachable case) — the old try/catch
      // never saw that and returned anyway, leaving the seat with no clock.
      //
      // ── Dan 2026-08-20: a pre-action is still an ACTION and must be seen ──
      //
      // This used to fire synchronously, at 0ms, the instant the turn arrived:
      // the seat lit up and its check/fold/call was already applied in the same
      // tick. The seat never visibly "took its turn" — with several players
      // holding pre-actions, a whole street resolved instantly and looked like
      // those players had been skipped.
      //
      // The player has already decided, so this is shorter than a horse's think
      // time — but it is never zero. The seat lights up, holds a readable beat,
      // and only then does the action land.
      // ═══ 2026-08-31: IDENTITY, not null-ness. The null-check below let a
      // pre-action from hand N land in hand N+1 whenever the hand was
      // replaced during the beat and the SAME seat happened to be on turn in
      // the new hand - the same player's next hand opens on the same seat, so
      // that is the common case, and their turn was consumed by an intent
      // they formed for a different hand. Same bug class as the stale-runout
      // race (#2318): a delayed continuation acting on whatever controller
      // the table holds when it wakes.
      const controllerAtBeat = this.handController;
      await this.sleep(this.preActionVisibleMs);
      // The hand can be replaced while we hold that beat.
      if (!this.running || this.handController !== controllerAtBeat || !controllerAtBeat) return;
      {
        const st = controllerAtBeat.getState();
        if (st.currentPlayerSeat !== seat) return;
      }
      let preApplied = false;
      try {
        preApplied = controllerAtBeat.performAction(
          seat,
          preResult.action as any,
          preResult.amount
        );
      } catch (err) {
        reportError(err, 'ServerTableEngine.' + this.tableId + '.preaction_threw');
      }
      if (preApplied) {
        console.log(
          `[ServerTableEngine:${this.tableId}] Pre-action executed: ${player.user_id} → ${preResult.action}${preResult.amount ? ` ${preResult.amount}` : ''}`
        );
        this.markProgress();
        return; // Pre-action handled the turn — no timer needed
      }
      console.warn(
        `[ServerTableEngine:${this.tableId}] Pre-action ${preResult.action} REJECTED at seat ${seat} - falling through to the turn timer`
      );
    }

    // Step 2: Check disconnect state before starting timer (applies to ALL players)
    const playerCanAct = this.disconnectEngine.onPlayerTurn(
      this.tableId,
      player.user_id,
      canCheckForPreAction
    );
    if (!playerCanAct) {
      // Player is disconnected or sitting out — DisconnectEngine will handle auto-action via callback
      return;
    }

    // Step 3: Reconnect grace (applies to ALL players)
    const reconnectGrace = this.disconnectEngine.isInReconnectGrace(this.tableId, player.user_id);
    const effectiveActionTime = reconnectGrace ? actionTime + 5 : actionTime;
    if (reconnectGrace) {
      console.log(
        `[ServerTableEngine:${this.tableId}] Player ${player.user_id} in reconnect grace - extending timer by 5s (${effectiveActionTime}s total)`
      );
    }

    // Step 4: Start the authoritative turn timer — SAME for horses and real players
    // Bible V8 §3.3: Turn FSM — waiting → timer_running
    this.turnFSM.transition('timer_running');
    this.startTurnTimer(player.user_id, seat, effectiveActionTime);

    // Step 5: If this is a horse, schedule their action after a realistic think time
    // The horse uses the SAME timer as a real player — the action fires within that timer window.
    // Think times: 2-8 seconds (varies by decision complexity to simulate real play)
    if (player.is_horse) {
      this.scheduleHorseAction(player, seat, enginePlayer, state);
    }
  }

  /**
   * Schedule a horse's action with realistic think time.
   * The horse's turn timer is ALREADY running (same as real players).
   * The horse submits its action within that timer window, just like a human would.
   */
  /**
   * V12 (2026-08-22): tournament context + format for the horse brain.
   * Synchronous — reads the TournamentBrainContext cache (background
   * refresh, 20s TTL). Cash tables return format 'cash' and no tournament
   * object; tournament tables before the first fetch return an empty
   * tournament object (V11 flat-premium behavior).
   */
  private horseTournamentContext(): {
    format: 'cash' | 'mtt' | 'spin' | 'hu_sng';
    tournament?: Record<string, unknown>;
  } {
    if (!this.isTournamentTable()) return { format: 'cash' as const };
    const tid = this.tableInfo?.tournament_id;
    const tctx = tid ? getTournamentBrainContext(tid) : null;
    const fallbackFormat =
      (this.tableInfo?.max_players ?? 9) <= 2 ? ('hu_sng' as const) : ('mtt' as const);
    if (!tctx) return { format: fallbackFormat, tournament: {} };
    return {
      format: tctx.format,
      tournament: {
        nearBubble: tctx.nearBubble,
        inMoney: tctx.inMoney,
        playersLeft: tctx.playersLeft,
        spotsPaid: tctx.spotsPaid,
        avgStackChips: tctx.avgStackChips,
        bountyFactor: tctx.bountyFactor,
        // V16 ICM: the payout curve + live stack distribution feed the real
        // Malmuth-Harville pressure model in HorseLogic.icmRisk.
        stacks: tctx.stacks,
        payoutPct: tctx.payoutPct,
        // V26 PRIZE LANDSCAPE: what a bust is actually worth right now -
        // how many chests are left, their mean, and whether the big one is
        // still in the box.
        mysteryChestsLeft: tctx.mysteryChestsLeft,
        mysteryMeanCents: tctx.mysteryMeanCents,
        mysteryTopCents: tctx.mysteryTopCents,
        mysteryTopLive: tctx.mysteryTopLive,
        meanBountyCents: tctx.meanBountyCents,
        // V23 ENDGAME: final-table flag + the blind clock (jam BEFORE the
        // blinds halve the M, not after).
        finalTable: tctx.finalTable,
        nextBlindInMin: tctx.nextBlindInMin,
        nextBlindMult: tctx.nextBlindMult,
      },
    };
  }

  protected scheduleHorseAction(
    player: SeatedPlayer,
    seat: number,
    enginePlayer: any,
    state: {
      currentBet: number;
      minRaise: number;
      pot: number;
      communityCards: any[];
      players: any[];
      stage: string;
    }
  ): void {
    const toCall = Math.max(0, state.currentBet - enginePlayer.bet);

    // AUDIT V2 (2026-07-23): horse_profile is a jsonb column — in production it
    // was {} for every horse, so the old styleMap[object] lookup ALWAYS fell
    // back to 'balanced' and all 574 horses played the identical style.
    // resolveHorseStyle handles strings, jsonb objects, and hashes the horse id
    // as a deterministic fallback so the fleet stays diverse no matter what.
    const { style: horseStyle, mods: horseMods } = resolveHorseStyle(
      player.horse_profile,
      player.user_id
    );

    const fullState = this.handController ? this.handController.getState() : null;
    const gameState = {
      // V28 AUDIT FIX (2026-08-29): is_sitting_out was hardcoded false at the
      // deal (correctly, for HandController's purposes), which made EVERY
      // !is_sitting_out filter in the brain inert — oppsLeft, tableSize,
      // classifyPosition and the postflop opponent count all counted a
      // blinding-off seat as a live opponent. At a 3-handed final table with
      // one player disconnected, the heads-up branches never fired: the SB
      // opened on 0.44 instead of 0.24. The engine has the truth in
      // DisconnectEngine; stamp it onto the copy the brain reads.
      players: state.players.map((p) => ({
        ...p,
        is_sitting_out:
          p.is_sitting_out === true || this.disconnectEngine.isSittingOut(this.tableId, p.user_id),
      })),
      communityCards: state.communityCards,
      // MULTI-BOARD EQUITY 2026-08-28 (Horses Are Players law): on a
      // double/triple-board bomb hand the fleet prices EVERY board — the
      // brain averages per-board equity, exactly what the pot pays on.
      communityCards2: fullState?.communityCards2 ?? [],
      communityCards3: fullState?.communityCards3 ?? [],
      pot: state.pot,
      currentBet: state.currentBet,
      minRaise: state.minRaise,
      stage: state.stage,
      // VARIANT OVERRIDE 2026-08-28: horses evaluate the hand they were DEALT
      // — PLO equity on a PLO bomb hand, whatever the table's label says.
      gameVariant: (this.activeHandVariant() || 'nlh') as string,
      bigBlind: this.tableInfo?.big_blind || 2,
      // AUDIT V2: position + action context for the V2 decision engine
      dealerSeat: fullState?.dealerSeat ?? this.currentHandDealerSeat,
      lastRaise: fullState?.lastRaise,
      actionHistory: fullState?.actionHistory,
      // V11 (Dan 2026-08-22): cash and tournaments are DIFFERENT games. Tell
      // the brain EXPLICITLY which one this is (it was guessing from blind
      // size) plus the ante, so preflop ranges, ICM pressure, push/fold
      // tiers, and rake-aware pot odds all switch on the real game mode.
      gameMode: this.isTournamentTable() ? ('tournament' as const) : ('cash' as const),
      ante: this.tableInfo?.ante || 0,
      // Which ante STYLE — the brain's M depends on what an orbit costs, and
      // a big blind ante costs the table one ante per orbit, not one each.
      bigBlindAnte: this.tableInfo?.big_blind_ante_enabled === true,
      // AoF: tell the brain, instead of rewriting its answer afterwards. The
      // coercion below stays as the legality guarantee.
      allInOrFold: this.tableInfo?.all_in_or_fold === true,
      // V18 STRADDLE (2026-08-26): straddle posts are not ActionRecords, so
      // a straddled pot's preflop currentBet (2xBB) with an empty history
      // read as an OPEN RAISE and the fleet folded to dead money. Tell the
      // brain straddles are possible here.
      // CASH ONLY (2026-08-31): the horse brain must not be told a straddle is
      // possible at a table where the engine will never post one.
      straddleActive: this.tableInfo?.straddle_enabled === true && !this.isTournamentTable(),
      // V12: REAL tournament state for the ICM layer — players left, spots
      // paid, average stack, PKO bounty share — plus the table format
      // (mtt/spin/hu_sng). Cached with a 20s TTL; null before the first
      // fetch lands, which degrades to the V11 flat premium.
      ...this.horseTournamentContext(),
    };

    // Get decision — SYNCHRONOUS (budgeted <15ms incl. Monte Carlo equity)
    // PROOF OF RECEIPT: telemetry is set HERE and only here — this is the
    // one call site that is a real horse at a real table.
    //
    // AND NOW MEASURED (Dan 2026-08-29). That "<15ms" was a comment, not a
    // fact: nothing in the engine had ever timed a decision. The whole read —
    // hand strength, board texture, the opponent model, blockers, ICM, the
    // Monte Carlo equity run, every version layer and the final sizing —
    // happens inside this one synchronous call, so one clock around it is the
    // complete answer to how long a horse takes to think.
    //
    // The clock is deliberately OUTSIDE HorseLogic: this is the only call site
    // that is a live horse, and the league and the nightly self-tuner must not
    // pollute the number with self-play bursts on an idle box.
    const decideStartedAt = perfNow();
    const decision = HorseLogic.decide(
      enginePlayer as any,
      gameState as any,
      horseStyle,
      horseMods,
      { telemetry: true }
    );
    // Scoped by variant family, because a 6-card PLO decision runs the most
    // expensive equity simulation on the platform and averaging it into a
    // heads-up NLH decision would hide both.
    //
    // FOUND IN PRODUCTION 2026-08-29, first hour of the measurement: every one
    // of the 14,326 samples landed in scope 'nlh' while 58 of 91 running
    // tables were dealing PLO variants. The horse snapshot built above carries
    // no `variant` field, so `(gameState as any)?.variant` was undefined on
    // EVERY decision and the ?? fallback relabelled them all — the exact
    // averaging-plo6-into-nlh failure this scope exists to prevent, with the
    // 15ms plo6 budget unverifiable in production as the result. Read
    // `activeHandVariant()` instead: it is the accessor the 2026-08-28 variant
    // override work introduced for precisely "read the live hand, not a guess",
    // and the same one the pot-limit clamp above already uses.
    noteDecisionMs(this.activeHandVariant() || 'nlh', perfNow() - decideStartedAt);

    // Humanlike think time comes from the decision engine itself (style- and
    // situation-aware, 0.7-8s). Clamp inside the table's action timer window.
    //
    // ── Dan 2026-08-20: "it doesn't matter if it's all horses at the table,
    //    every action, every animation, every feature and detail needs to play
    //    out in full. Each turn to check/bet/call/fold, every action needs
    //    time, nothing can EVER be skipped." ──
    //
    // HISTORY, kept because it explains what replaced it: this used to impose
    // a hard think-time floor so that no action could be fast enough to clip
    // its own animation. The animation concern was real, but the floor was the
    // wrong instrument — the settle beat in the TURN_CHANGE handler is what
    // actually guarantees an action gets airtime, and it applies to human
    // actions too. The floor only flattened the horses' timing, which is what
    // Dan reported on 2026-08-23.
    // Dan 2026-08-20: "THE GAME SPEED NEEDS TO SLOW DOWN TO FEEL MORE REAL.
    // Focus more on the user experience rather than getting more hands dealt."
    // Raised 1800 -> 2200. A live dealer's table does not fire an action every
    // second and a half; the extra beat is what makes a horse read as a person
    // thinking rather than a script executing. This is ON TOP of the 650ms
    // settle every action now gets in the TURN_CHANGE handler, so the slowest
    // visible cadence per seat is ~2.85s and the fastest is never instant.
    // ── V14 TEMPO (Dan 2026-08-23, binding) ────────────────────────────────
    // "TIMING ON STREETS MUST BE MORE RANDOM... completely random, from
    //  instant, to full 15 seconds or even using time banks."
    //
    // The 2200ms floor above was the single biggest reason the fleet felt
    // scripted. HorseLogic already produced a spread, and this clamped the
    // whole fast half of it onto ONE NUMBER — so seat after seat acted at
    // exactly 2.2 seconds. Removing it is the point of this change; the
    // 650ms settle in the TURN_CHANGE handler still keeps a snap from being
    // literally instantaneous.
    //
    // This supersedes the 2026-08-20 note above it. That instruction was
    // "slow the game down so it feels real"; this one is "make the timing
    // genuinely random", and a uniform slow cadence is just a slower script.
    const actionTimeMs = (this.tableInfo?.action_time_seconds || 15) * 1000;
    const requested = decision.thinkTime || 2500;
    let thinkTimeMs: number;
    // V28 AUDIT FIX (2026-08-29): the sentinel path scheduled the action PAST
    // the turn clock with no check that a bank existed to catch it. A horse's
    // bank is 2 uses per session, never refilled — after both were spent,
    // primary-timer expiry auto-folded the seat, the real decision fired into
    // currentPlayerSeat !== seat and was silently discarded. The horse that
    // decided to CALL a big river bet visibly timed out and folded — the one
    // behaviour a human at the table cannot fail to notice. Bank mode fires
    // on 1-6% of decisions, weighted toward exactly those big river spots.
    // Same shape when time_bank is disabled table-wide, and when the last
    // bank has fewer seconds left than the planned burn. So: burn the bank
    // ONLY when a full activation is genuinely available; otherwise the tank
    // stays inside the ordinary clock.
    const bank = this.timeBankEngine?.getPlayerBank?.(this.tableId, player.user_id);
    const bankUsable =
      this.tableInfo?.time_bank_enabled !== false &&
      bank != null &&
      (bank as { usesRemaining?: number }).usesRemaining !== 0 &&
      ((bank as { remainingSeconds?: number }).remainingSeconds ?? 0) * 1000 >
        ServerTableEngineTurns.HORSE_MAX_BANK_BURN_MS + 2000;
    if (requested >= HorseLogic.THINK_TIMEBANK_SENTINEL && bankUsable) {
      // A deliberate TIME BANK burn. Let the turn clock expire — the engine
      // auto-activates the bank on primary-timer expiry (Bible V8 6.2) — then
      // act a few seconds into it. Bounded well inside the granted bank so a
      // tank can never become an auto-fold.
      const intoBank = 2000 + (requested - HorseLogic.THINK_TIMEBANK_SENTINEL) * 0.55;
      thinkTimeMs = Math.round(
        actionTimeMs + Math.min(intoBank, ServerTableEngineTurns.HORSE_MAX_BANK_BURN_MS)
      );
    } else if (requested >= HorseLogic.THINK_TIMEBANK_SENTINEL) {
      // Bank mode chosen but no bank to burn: the longest legal ordinary tank.
      thinkTimeMs = Math.round(Math.max(2000, actionTimeMs - 1500));
    } else {
      // Everything else must land inside the ordinary clock, with a small
      // margin so a genuine tank still acts rather than timing out.
      thinkTimeMs = Math.round(
        Math.max(250, Math.min(requested, Math.max(2000, actionTimeMs - 1200)))
      );
    }

    const handControllerRef = this.handController;

    // 2026-08-22: clear any prior think-timer before overwriting the handle —
    // re-entry used to orphan the previous setTimeout (it still fired; only
    // the identity guards below kept it harmless).
    if (this.horseActionTimer) {
      clearTimeout(this.horseActionTimer);
      this.horseActionTimer = null;
    }
    this.horseActionTimer = setTimeout(() => {
      this.horseActionTimer = null;
      if (!handControllerRef || !this.running) return;

      // AUDIT V2 FIX: if a NEW hand started, this.handController was replaced.
      // Without this identity check a stale think-timer could fire an action
      // into the wrong hand's controller (same seat, next hand).
      if (handControllerRef !== this.handController) return;

      // Verify it's still this player's turn (timer might have expired)
      const currentState = handControllerRef.getState();
      if (currentState.currentPlayerSeat !== seat) return;

      let action = decision.action as string;
      let amount = decision.amount;

      // ── ALL-IN-OR-FOLD (2026-08-22 parity) ────────────────────────────────
      // At an AoF table the preflop menu is fold or shove, and HandController
      // rejects everything else. The horse brain does not know about AoF, so
      // its decision is coerced here: any non-fold intent becomes the all-in.
      // (A fold with nothing owed still normalizes to the legal check below.)
      if (this.tableInfo?.all_in_or_fold && currentState.stage === 'preflop') {
        if (action !== 'fold') {
          action = 'all_in';
          amount = undefined;
        }
      }

      // Normalize actions
      if (action === 'allin') action = 'all_in';
      if (action === 'check' && toCall > 0) action = 'call';
      if (action === 'call' && toCall === 0) action = 'check';
      if (action === 'call') amount = toCall;
      if (action === 'fold' && toCall === 0) action = 'check';
      if (action === 'raise' && state.currentBet === 0) action = 'bet';
      if (action === 'bet' && state.currentBet > 0) action = 'raise';

      // Clamp amounts
      //
      // 2026-08-23: the horses size their bets no-limit style (HorseLogic reads
      // only `isPotLimit`). On a fixed-limit table every one of those sizings is
      // illegal, so without this snap each horse decision would be rejected and
      // fall through to the check/fold degradation below — a limit table full of
      // bots that never bet. Snap to the street's legal wager instead, exactly
      // as the human path does.
      // Same 2026-08-28 override correction as the human clamp above: the
      // hand's variant, not the table's.
      const horseFlBetSize = isFixedLimitVariant(this.activeHandVariant())
        ? // The horse snapshot types `stage` as a bare string; the values are
          // the same HandStage literals the controller emits.
          fixedLimitBetSize(this.tableInfo?.big_blind ?? 2, state.stage as HandStage)
        : 0;
      /* CAP FIX 2026-08-27: the horse path is a parallel implementation of the
         human clamp chain and carried NO cap term at all — `cap_enabled` /
         `cap_bb` were read only in _handlePlayerActionInner, so a horse at a
         capped table sized and shoved against its raw stack, straight past the
         ceiling the host set. Same arithmetic as the human path. */
      const horseCapBB = Number(this.tableInfo?.cap_bb) || 0;
      const horseCapChips =
        this.tableInfo?.cap_enabled === true && horseCapBB > 0
          ? horseCapBB * (Number(this.tableInfo?.big_blind) || 0)
          : 0;
      const horseCapRemaining =
        horseCapChips > 0
          ? Math.max(0, horseCapChips - (Number(enginePlayer.totalInvested) || 0))
          : Infinity;
      if (action === 'bet' && amount !== undefined) {
        amount = horseFlBetSize > 0 ? horseFlBetSize : Math.max(state.minRaise, amount);
        amount = Math.min(amount, horseCapRemaining);
        // Only the STACK promotes to all_in; a cap-bounded wager stays sized.
        if (amount >= enginePlayer.stack && enginePlayer.stack <= horseCapRemaining) {
          action = 'all_in';
          amount = undefined;
        }
      } else if (action === 'raise' && amount !== undefined) {
        const minRaiseTo = state.currentBet + state.minRaise;
        amount =
          horseFlBetSize > 0 ? state.currentBet + horseFlBetSize : Math.max(minRaiseTo, amount);
        const horseCapRaiseTo =
          horseCapRemaining === Infinity ? Infinity : enginePlayer.bet + horseCapRemaining;
        amount = Math.min(amount, horseCapRaiseTo);
        const horseStackRaiseTo = enginePlayer.stack + enginePlayer.bet;
        const maxRaiseTo = Math.min(horseStackRaiseTo, horseCapRaiseTo);
        if (amount >= maxRaiseTo && horseStackRaiseTo <= horseCapRaiseTo) {
          action = 'all_in';
          amount = undefined;
        }
      }

      // 2026-08-24: a capped fixed-limit street takes no further wager, and
      // validateAction refuses one whatever the amount. The degradation below is
      // `check() || fold()`, and on a capped street facing a bet `check` is
      // illegal too — so a horse that wanted to RAISE folded the hand it had
      // just decided to raise with. Substitute the closest legal intent instead
      // (call when money is owed, check when none is), which cannot be refused.
      // The horse snapshot is a reduced shape with no actionHistory, so the cap
      // is read from the controller's own state — the same list validateAction
      // will be judged against a few lines below.
      const liveState = handControllerRef.getState();
      if (
        horseFlBetSize > 0 &&
        isFixedLimitCapped(liveState.actionHistory ?? [], liveState.stage)
      ) {
        const substituted = substituteOnCappedStreet(action as ActionType, toCall);
        if (substituted !== action) {
          action = substituted as typeof action;
          amount = substituted === 'call' ? toCall : undefined;
        }
      }

      // 2026-08-15 FREEZE FIX. HandController.performAction RETURNS FALSE on an
      // illegal action — it does not throw (HandController.ts:416/430/437). So
      // this catch never fired, and a horse whose decision the engine rejected
      // (stale raise amount, re-open rule, min-raise floor) simply never acted.
      // The human path was already fixed for exactly this in July ("the table
      // froze with no clock", Turns.ts SWEEP #4); the horse path was missed.
      // Check the boolean and degrade the same way a rejected human action does:
      // check if free, else fold. A seat must never be left unacted.
      let applied = false;
      try {
        applied = handControllerRef.performAction(seat, action as any, amount);
      } catch (err) {
        reportError(err, 'ServerTableEngine.' + this.tableId + '.horse_action_threw');
      }
      if (!applied) {
        console.warn(
          '[ServerTableEngine:' +
            this.tableId +
            '] Horse action ' +
            action +
            ' rejected at seat ' +
            seat +
            ' - falling back to check/fold'
        );
        try {
          // Bible V8 §1.7.4 preferCheckOverFold.
          applied =
            handControllerRef.performAction(seat, 'check' as any) ||
            handControllerRef.performAction(seat, 'fold' as any);
        } catch {
          /* Hand already resolved. */
        }
      }
      // Unconditional markProgress() here reset watchdogTrips even when all
      // three actions were rejected, hiding a genuine stall for a full window.
      if (applied) {
        this.markProgress();
      } else {
        reportError(
          new Error(
            'Horse seat ' + seat + ' could not be acted - leaving stall visible to watchdog'
          ),
          'ServerTableEngine.' + this.tableId + '.horse_seat_unactable'
        );
      }
    }, thinkTimeMs);
  }
}
