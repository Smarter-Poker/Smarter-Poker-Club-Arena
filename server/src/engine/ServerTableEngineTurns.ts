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
import { HorseLogic, resolveHorseStyle } from './HorseLogic.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';
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

export abstract class ServerTableEngineTurns extends ServerTableEngineSeating {
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
  protected clearTurnTimer(): void {
    this.preciseTimer.clearTable(this.tableId);
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
              'min — hand-for-hand/break coordinator may have lost the resume signal'
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
          !this.disconnectEngine.isSittingOut(this.tableId, p.user_id) &&
          !this.waitingForBB.has(p.user_id)
      ).length;
      if (dealable >= 2 && idleMs > ServerTableEngineBase.WATCHDOG_IDLE_MS) {
        this.watchdogTrips++;
        reportError(
          new Error(
            'Table idle ' +
              Math.round(idleMs / 1000) +
              's with ' +
              dealable +
              ' dealable seats — dealing loop is not looping'
          ),
          'ServerTableEngine.' + this.tableId + '.watchdog_loop_dead',
          { handCount: this.handCount, trips: this.watchdogTrips }
        );
        if (this.watchdogTrips >= 2) this.killForRestart('dealing_loop_dead');
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
          'forced ' + forced + ' at seat ' + seat + ' after ' + Math.round(idleMs / 1000) + 's stall'
        );
        this.markProgress();
      } else {
        reportError(
          new Error('Watchdog forced action REJECTED at seat ' + seat + ' — escalating to rebuild'),
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

    this.preciseTimer.startTimer(this.tableId, userId, totalDurationMs, () => {
      // === onExpiry callback — fires when DeadlineScheduler tick reaches deadline ===
      if (!this.running || !this.handController) return;

      const state = this.handController.getState();
      if (state.currentPlayerSeat !== seat) return;

      // Bible V8 §6.2: Auto-activate time bank when primary timer expires
      // FIX: Guard against race condition where the player already submitted an action
      // and the FSM advanced to 'processing' or 'complete' before this timer callback fired.
      // Only attempt time bank auto-activation if the turn is still in 'timer_running'.
      if (!this.timeBankActivatedThisTurn && this.turnFSM.state === 'timer_running') {
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
                `[ServerTableEngine:${this.tableId}] Time bank expiry: FSM in '${this.turnFSM.state}' but seat ${seat} is still current — resolving anyway`
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
                new Error('Time bank auto-action rejected at seat ' + seat + ' — re-arming clock'),
                'ServerTableEngine.' + this.tableId + '.timebank_auto_action_rejected'
              );
              this.forceArmTurnTimer(seat, this.tableInfo?.action_time_seconds || 15);
            }

            // Bible V8 §3.3: Turn FSM — processing → complete
            this.turnFSM.transition('complete');

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
              `[ServerTableEngine:${this.tableId}] Time bank auto-activation skipped — FSM is '${this.turnFSM.state}' (expected timer_running). Turn already resolved.`
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
          const grantedSeconds = bank?.currentUseSeconds ?? 15;
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
          new Error('Timeout auto-action rejected at seat ' + seat + ' — re-arming clock'),
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
  public async activateTimeBank(userId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.handController || !this.tableInfo) {
      return { success: false, error: 'No active hand or table info missing' };
    }

    const state = this.handController.getState();
    const player = state.players.find((p) => p.user_id === userId);

    if (!player || state.currentPlayerSeat !== player.seat) {
      return { success: false, error: 'Not your turn' };
    }

    if (this.timeBankActivatedThisTurn) {
      return { success: false, error: 'Time bank already activated this turn' };
    }

    // Bible V8 §6.2: Check via TimeBankEngine (single source of truth for pool + per-hand limits)
    if (!this.timeBankEngine.hasTimeBank(this.tableId, userId)) {
      // VIP time banks 2026-08-17: a diamond top-up purchased mid-session
      // lives only in the DB. Refresh once before rejecting, then re-validate
      // the turn - the await may have raced the action.
      const refreshed = await this.refreshTimeBankFromDb(userId);
      if (!refreshed || !this.timeBankEngine.hasTimeBank(this.tableId, userId)) {
        return { success: false, error: 'No time bank uses remaining' };
      }
      const stateAfter = this.handController?.getState();
      if (!stateAfter || stateAfter.currentPlayerSeat !== player.seat) {
        return { success: false, error: 'Not your turn' };
      }
      if (this.timeBankActivatedThisTurn) {
        return { success: false, error: 'Time bank already activated this turn' };
      }
    }

    // Activate via TimeBankEngine — it handles pool depletion, per-hand limit, and event emission
    const activated = this.timeBankEngine.activate(this.tableId, userId, () => {
      // This callback fires when the manual time bank expires
      if (!this.running || !this.handController) return;
      const tbState = this.handController.getState();
      if (tbState.currentPlayerSeat !== player.seat) return;

      const tbPlayer = tbState.players.find((p) => p.seat === player.seat);
      const tbToCall = tbPlayer ? Math.max(0, tbState.currentBet - (tbPlayer.bet ?? 0)) : 0;
      const tbCanCheck = tbToCall === 0;

      if (tbCanCheck) {
        try {
          this.handController!.performAction(player.seat, 'check');
        } catch {
          try {
            this.handController!.performAction(player.seat, 'fold');
          } catch {
            /* done */
          }
        }
      } else {
        try {
          this.handController!.performAction(player.seat, 'fold');
        } catch {
          /* done */
        }
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
    });

    if (!activated) {
      return { success: false, error: 'Time bank activation failed (per-hand limit or depleted)' };
    }

    this.timeBankActivatedThisTurn = true;

    // Get bank info for the broadcast
    const bank = this.timeBankEngine.getPlayerBank(this.tableId, userId);
    const bankSeconds = bank ? bank.currentUseSeconds : 15;

    // Calculate remaining normal time and add bank time
    const elapsed = (Date.now() - this.playerTurnStartTime) / 1000;
    const remainingBeforeBank = Math.max(0, this.playerTurnDuration - elapsed);
    const newDuration = remainingBeforeBank + bankSeconds;

    console.log(
      `[ServerTableEngine:${this.tableId}] Player ${userId} manually activated time bank. Adding ${bankSeconds}s. Total: ${Math.round(newDuration)}s`
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
        .catch(() => {});
    } catch (e) {}

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
  public heartbeat(userId: string): {
    success: boolean;
    connected: boolean;
    gracePeriodRemaining: number;
  } {
    this.disconnectEngine.heartbeat(this.tableId, userId);
    const connected = this.disconnectEngine.isConnected(this.tableId, userId);
    return { success: true, connected, gracePeriodRemaining: 0 };
  }

  /**
   * POST /preaction — Bible V8 §4.15: Set or clear a pre-action
   */
  public setPreAction(
    userId: string,
    action: string,
    maxCallAmount?: number
  ): { success: boolean; error?: string } {
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

    this.preActionEngine.setPreAction(this.tableId, userId, action as any, maxCallAmount);

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

    return { success: true };
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
      return { success: false, error: 'Action already being processed — try again' };
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
    if (normalizedAction === 'fold' && toCall === 0) normalizedAction = 'check';
    if (normalizedAction === 'raise' && state.currentBet === 0) normalizedAction = 'bet';
    if (normalizedAction === 'bet' && state.currentBet > 0) normalizedAction = 'raise';

    // Bible V8 §4.14: Pot-limit max raise for PLO variants
    const isPotLimit = this.tableInfo?.game_variant?.startsWith('plo');
    let potLimitMaxBet = Infinity;
    if (isPotLimit) {
      // FIX 142: Pot-limit max raise SIZE = pot + toCall (the pot after you call).
      // Previous formula (pot + toCall + toCall) was one toCall too permissive.
      // For a BET (toCall=0): maxBet = pot. For a RAISE: maxRaiseSize = pot + toCall.
      // This matches PokerEngine.calculateBettingState (FIX 121).
      potLimitMaxBet = state.pot + toCall;
    }

    // Clamp amounts
    if (normalizedAction === 'call') amount = toCall;
    if (normalizedAction === 'bet' && amount !== undefined) {
      amount = Math.max(state.minRaise, amount);
      // Bible V8 §4.14: Cap at pot-limit max for PLO
      if (isPotLimit) {
        amount = Math.min(amount, potLimitMaxBet);
      }
      if (amount >= player.stack) {
        normalizedAction = 'all_in';
        amount = undefined;
      }
    } else if (normalizedAction === 'raise' && amount !== undefined) {
      const minRaiseTo = state.currentBet + state.minRaise;
      amount = Math.max(minRaiseTo, amount);
      // Bible V8 §4.14: Cap at pot-limit max for PLO (raise TO = currentBet + potLimitMaxBet)
      if (isPotLimit) {
        const potLimitRaiseTo = state.currentBet + potLimitMaxBet;
        amount = Math.min(amount, potLimitRaiseTo);
      }
      const maxRaiseTo = player.stack + player.bet;
      if (amount >= maxRaiseTo) {
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
      // Bible V8 §6.2: If time bank was active, notify engine to deduct used time from pool
      if (this.timeBankActivatedThisTurn) {
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
          `[ServerTableEngine:${this.tableId}] Engine REJECTED action ${normalizedAction} from ${userId} — re-arming turn timer`
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

    const minRaiseTo = state.currentBet > 0 ? state.currentBet + state.minRaise : state.minRaise;
    let maxRaiseTo = player.stack + player.bet;

    // FIX 176: Bible V8 §4.14: Cap maxRaise for pot-limit games (PLO variants)
    // Pot-limit max raise SIZE = pot + toCall (the pot after you call).
    // Raise TO = currentBet + (pot + toCall). The old formula had an extra toCall
    // which allowed raises ~toCall higher than legal pot-limit max.
    const isPotLimit = this.tableInfo?.game_variant?.startsWith('plo');
    if (isPotLimit) {
      const potLimitMaxBet = state.pot + toCall;
      const potLimitRaiseTo = state.currentBet + potLimitMaxBet;
      maxRaiseTo = Math.min(maxRaiseTo, potLimitRaiseTo);
    }

    return {
      canAct: true,
      actions,
      toCall,
      minRaise: minRaiseTo,
      maxRaise: maxRaiseTo,
      pot: state.pot,
    };
  }

  /**
   * Handle horse AI turn — INSTANT decisions, no browser timers needed
   */
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
    const timeBankAlreadyUsedThisTurn = this.timeBankActivatedThisTurn;
    this.handleTurnChange(
      { type: 'TURN_CHANGE', seat: player.seat, availableActions: [] } as HandEvent,
      this.seatedPlayers
    );

    this.timeBankActivatedThisTurn = timeBankAlreadyUsedThisTurn;
  }

  protected handleTurnChange(event: HandEvent, players: SeatedPlayer[]): void {
    if (event.type !== 'TURN_CHANGE' || !this.handController) return;

    const seat = event.seat;
    const player = players.find((p) => p.seat_number === seat);
    if (!player) return;

    const state = this.handController.getState();
    const enginePlayer = state.players.find((p) => p.seat === seat);
    if (!enginePlayer) return;

    // ═══════════════════════════════════════════════════════════════════════
    // UNIFIED TURN HANDLING — Horses and real players follow the EXACT same flow.
    // Bible V8: Horses MUST be indistinguishable from real players.
    // Same timer, same broadcast, same action path. NO EXCEPTIONS.
    // ═══════════════════════════════════════════════════════════════════════

    const actionTime = this.tableInfo?.action_time_seconds || 15;
    this.timeBankActivatedThisTurn = false; // Reset anti-spam lock for this NEW turn

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
      let preApplied = false;
      try {
        preApplied = this.handController!.performAction(
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
        `[ServerTableEngine:${this.tableId}] Pre-action ${preResult.action} REJECTED at seat ${seat} — falling through to the turn timer`
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
        `[ServerTableEngine:${this.tableId}] Player ${player.user_id} in reconnect grace — extending timer by 5s (${effectiveActionTime}s total)`
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
      players: state.players,
      communityCards: state.communityCards,
      pot: state.pot,
      currentBet: state.currentBet,
      minRaise: state.minRaise,
      stage: state.stage,
      gameVariant: (this.tableInfo?.game_variant || 'nlh') as string,
      bigBlind: this.tableInfo?.big_blind || 2,
      // AUDIT V2: position + action context for the V2 decision engine
      dealerSeat: fullState?.dealerSeat ?? this.currentHandDealerSeat,
      lastRaise: fullState?.lastRaise,
      actionHistory: fullState?.actionHistory,
    };

    // Get decision — SYNCHRONOUS (budgeted <15ms incl. Monte Carlo equity)
    const decision = HorseLogic.decide(
      enginePlayer as any,
      gameState as any,
      horseStyle,
      horseMods
    );

    // Humanlike think time comes from the decision engine itself (style- and
    // situation-aware, 0.7-8s). Clamp inside the table's action timer window.
    const actionTimeMs = (this.tableInfo?.action_time_seconds || 15) * 1000;
    const thinkTimeMs = Math.round(
      Math.max(700, Math.min(decision.thinkTime || 2500, Math.max(2000, actionTimeMs - 3000)))
    );

    const handControllerRef = this.handController;

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

      // Normalize actions
      if (action === 'allin') action = 'all_in';
      if (action === 'check' && toCall > 0) action = 'call';
      if (action === 'call' && toCall === 0) action = 'check';
      if (action === 'call') amount = toCall;
      if (action === 'fold' && toCall === 0) action = 'check';
      if (action === 'raise' && state.currentBet === 0) action = 'bet';
      if (action === 'bet' && state.currentBet > 0) action = 'raise';

      // Clamp amounts
      if (action === 'bet' && amount !== undefined) {
        amount = Math.max(state.minRaise, amount);
        if (amount >= enginePlayer.stack) {
          action = 'all_in';
          amount = undefined;
        }
      } else if (action === 'raise' && amount !== undefined) {
        const minRaiseTo = state.currentBet + state.minRaise;
        amount = Math.max(minRaiseTo, amount);
        const maxRaiseTo = enginePlayer.stack + enginePlayer.bet;
        if (amount >= maxRaiseTo) {
          action = 'all_in';
          amount = undefined;
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
            ' — falling back to check/fold'
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
            'Horse seat ' + seat + ' could not be acted — leaving stall visible to watchdog'
          ),
          'ServerTableEngine.' + this.tableId + '.horse_seat_unactable'
        );
      }
    }, thinkTimeMs);
  }
}
