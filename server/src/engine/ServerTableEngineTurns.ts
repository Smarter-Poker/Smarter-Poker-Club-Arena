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
import {
  supabase,
} from '../services/supabase.js';
import type {
  HandEvent,
  SeatedPlayer,
} from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { ServerTableEngineSeating } from './ServerTableEngineSeating.js';

export abstract class ServerTableEngineTurns extends ServerTableEngineSeating {

  // ═════════════════════════════════════════════════════════════════════════════
  // TURN TIMER MANAGEMENT
  // ═════════════════════════════════════════════════════════════════════════════

  protected clearTurnTimer(): void {
    // Phase 1.2: Cancel the PreciseActionTimer for the current player.
    // The old setTimeout-based playerTurnTimer has been deleted.
    // PreciseActionTimer.cancelTimer is called per-player in handleTurnChange,
    // and clearTable is used for full hand cleanup.
  }

  protected startTurnTimer(userId: string, seat: number, durationSeconds: number): void {
    this.clearTurnTimer();
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
            if (this.turnFSM.state === 'time_bank_active') {
              this.turnFSM.transition('expired');
              this.turnFSM.transition('processing');
            } else {
              // Turn was already resolved (player acted during time bank delay) — bail silently
              console.warn(
                `[ServerTableEngine:${this.tableId}] Time bank expiry skipped — FSM already in '${this.turnFSM.state}' (race condition: player acted)`
              );
              return;
            }
            if (!this.running || !this.handController) return;
            const tbState = this.handController.getState();
            if (tbState.currentPlayerSeat !== seat) return;

            const tbPlayer = tbState.players.find((p) => p.seat === seat);
            const tbToCall = tbPlayer ? Math.max(0, tbState.currentBet - (tbPlayer.bet ?? 0)) : 0;
            const tbCanCheck = tbToCall === 0;

            if (tbCanCheck) {
              console.warn(
                `[ServerTableEngine:${this.tableId}] Player ${userId} time bank expired. Auto-checking.`
              );
              try {
                this.handController!.performAction(seat, 'check');
              } catch {
                try {
                  this.handController!.performAction(seat, 'fold');
                } catch {
                  /* done */
                }
              }
            } else {
              console.warn(
                `[ServerTableEngine:${this.tableId}] Player ${userId} time bank expired. Auto-folding.`
              );
              try {
                this.handController!.performAction(seat, 'fold');
              } catch {
                /* done */
              }
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
          const bankSeconds = this.timeBankEngine.getRemainingSeconds(this.tableId, userId);
          const usesAfterActivation = this.timeBankEngine.getUsesRemaining(this.tableId, userId);
          console.log(
            `[ServerTableEngine:${this.tableId}] Auto-activated time bank for ${userId} (${bankSeconds}s remaining, ${usesAfterActivation} uses left)`
          );
          // Restart turn timer with time bank duration
          this.startTurnTimer(userId, seat, bankSeconds);

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

      if (canCheck) {
        console.warn(
          `[ServerTableEngine:${this.tableId}] Player ${userId} timed out. Auto-checking (no bet to call).`
        );
        try {
          this.handController.performAction(seat, 'check');
        } catch (err) {
          reportError(err, 'ServerTableEnginethistableId.Autocheck_failed');
          try {
            this.handController.performAction(seat, 'fold');
          } catch (foldErr) {
            reportError(foldErr, 'ServerTableEnginethistableId.Autofold_fallback_also_failed');
          }
        }
      } else {
        console.warn(
          `[ServerTableEngine:${this.tableId}] Player ${userId} timed out. Auto-folding (${amountToCall} to call).`
        );
        try {
          this.handController.performAction(seat, 'fold');
        } catch (err) {
          reportError(err, 'ServerTableEnginethistableId.Autofold_failed');
        }
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
  public activateTimeBank(userId: string): { success: boolean; error?: string } {
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
      return { success: false, error: 'No time bank uses remaining' };
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

  // ═════════════════════════════════════════════════════════════════════════════
  // MISSING ENDPOINTS — Bible V8 Required (heartbeat, preaction, sitout, state)
  // ═════════════════════════════════════════════════════════════════════════════

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
    return { success: true };
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // REAL PLAYER ACTION — Accept actions from HTTP endpoint
  // ═════════════════════════════════════════════════════════════════════════════

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
    this.handleTurnChange(
      { type: 'TURN_CHANGE', seat: player.seat, availableActions: [] } as HandEvent,
      this.seatedPlayers
    );
  }

  protected handleTurnChange(event: HandEvent, players: SeatedPlayer[]): void {
    if (event.type !== 'TURN_CHANGE' || !this.handController) return;

    const seat = event.seat;
    const player = players.find((p) => p.seat_number === seat);
    if (!player) return;

    const state = this.handController.getState();
    const enginePlayer = state.players.find((p) => p.seat === seat);
    if (!enginePlayer) return;

    // ═══════════════════════════════════════════════════════════════════════════
    // UNIFIED TURN HANDLING — Horses and real players follow the EXACT same flow.
    // Bible V8: Horses MUST be indistinguishable from real players.
    // Same timer, same broadcast, same action path. NO EXCEPTIONS.
    // ═══════════════════════════════════════════════════════════════════════════

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
      try {
        this.handController!.performAction(seat, preResult.action as any, preResult.amount);
        console.log(
          `[ServerTableEngine:${this.tableId}] Pre-action executed: ${player.user_id} → ${preResult.action}${preResult.amount ? ` ${preResult.amount}` : ''}`
        );
        return; // Pre-action handled the turn — no timer needed
      } catch (err) {
        console.warn(
          `[ServerTableEngine:${this.tableId}] Pre-action failed, falling through to timer:`,
          err
        );
      }
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

    setTimeout(() => {
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

      try {
        handControllerRef.performAction(seat, action as any, amount);
      } catch {
        // FIX 210: Bible V8 §1.7.4 — preferCheckOverFold: try check before fold
        try {
          handControllerRef.performAction(seat, 'check');
        } catch {
          try {
            handControllerRef.performAction(seat, 'fold');
          } catch {
            /* Hand done */
          }
        }
      }
    }, thinkTimeMs);
  }
}
