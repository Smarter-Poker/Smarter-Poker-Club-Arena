/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PRE-ACTION ENGINE — Queued Actions Before Player's Turn
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Allows players to set actions before their turn arrives:
 * - Auto-fold: fold when it's your turn (regardless of action)
 * - Auto-check/fold: check if free, fold if there's a bet
 * - Auto-check: check if free (clear if there's a bet)
 * - Auto-call: call any bet when it's your turn
 * - Validates queued actions are still legal when turn arrives
 * - Optional event callbacks for UI synchronization
 *
 * Ported from client: src/engine/PreActionEngine.ts
 * Server adaptation: No masterBus — uses server ActionType + callbacks.
 */

import type { ActionType } from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { createPreActionStateMachine, type PreActionFSMState } from './StateMachine.js';
import type { StateMachine } from './StateMachine.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type PreActionType =
  | 'auto_fold' // Always fold
  | 'auto_check_fold' // Check if free, fold if bet
  | 'auto_check' // Check if free, clear if bet
  | 'auto_call' // Call any bet
  | 'auto_call_any'; // Call any amount (dangerous!)

export interface PreActionEntry {
  playerId: string;
  tableId: string;
  action: PreActionType;
  setAt: number;
  /** If the action involves calling, the max amount the player agreed to */
  maxCallAmount?: number;
  /**
   * Dan 2026-08-28 (CRITICAL, verbatim): "I was in the small blind and
   * clicked the Call 15 button (NOT the Call Any button), it auto called a
   * raise which was more than the 15. THAT CAN NEVER EVER EVER HAPPEN."
   *
   * The price to call AT THE MOMENT THE PRE-ACTION WAS SET, recorded by the
   * ENGINE (ServerTableEngineTurns.setPreAction), never trusted from the
   * client. `maxCallAmount` was always optional and the client never sent
   * it, so the `auto_call` cap guard below never fired and `auto_call`
   * degenerated to `auto_call_any`. This field closes that hole on the
   * server side regardless of what any client version sends: an `auto_call`
   * may execute only at (or under) the price the player saw when they
   * pressed the button.
   */
  toCallAtSet?: number;
}

export interface PreActionResult {
  executed: boolean;
  action?: ActionType;
  amount?: number;
  invalidated?: boolean;
  reason?: string;
}

export type PreActionEventType =
  | 'PRE_ACTION_SET'
  | 'PRE_ACTION_EXECUTED'
  | 'PRE_ACTION_INVALIDATED';

export interface PreActionEvent {
  type: PreActionEventType;
  tableId: string;
  playerId: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRE-ACTION ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class PreActionEngine {
  private queuedActions: Map<string, PreActionEntry> = new Map(); // key: tableId:playerId
  /** Bible V8 §3.4: Per-player Pre-Action FSM tracking */
  private playerFSMs: Map<string, StateMachine<PreActionFSMState>> = new Map();
  private onEvent?: (event: PreActionEvent) => void;

  constructor(onEvent?: (event: PreActionEvent) => void) {
    this.onEvent = onEvent;
  }

  /** Get or create the FSM for a specific player at a table */
  private getFSM(tableId: string, playerId: string): StateMachine<PreActionFSMState> {
    const key = `${tableId}:${playerId}`;
    let fsm = this.playerFSMs.get(key);
    if (!fsm) {
      fsm = createPreActionStateMachine('idle');
      this.playerFSMs.set(key, fsm);
    }
    return fsm;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SET / CLEAR PRE-ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Set a pre-action for a player
   */
  setPreAction(
    tableId: string,
    playerId: string,
    action: PreActionType,
    maxCallAmount?: number,
    toCallAtSet?: number
  ): void {
    const key = `${tableId}:${playerId}`;
    const fsm = this.getFSM(tableId, playerId);

    // FSM: idle → queued. 2026-08-22 review: re-queueing while already
    // 'queued' (player changes their pre-action, or leaveTable queues an
    // auto_fold over an existing selection) fired an invalid queued→queued
    // transition straight into Sentry on a routine flow. Step through idle
    // first when the FSM allows it.
    if (fsm.state !== 'idle' && fsm.canTransition('idle')) {
      fsm.transition('idle');
    }
    fsm.transition('queued');

    this.queuedActions.set(key, {
      playerId,
      tableId,
      action,
      setAt: Date.now(),
      maxCallAmount,
      toCallAtSet,
    });

    this.emitEvent({
      type: 'PRE_ACTION_SET',
      tableId,
      playerId,
      action,
    });
  }

  /**
   * Clear a pre-action for a player
   */
  clearPreAction(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    const fsm = this.getFSM(tableId, playerId);

    // FSM: queued → idle (player manually clears or new hand)
    if (fsm.canTransition('idle')) {
      fsm.transition('idle');
    }

    this.queuedActions.delete(key);
  }

  /**
   * Get the current pre-action for a player
   */
  getPreAction(tableId: string, playerId: string): PreActionEntry | null {
    const key = `${tableId}:${playerId}`;
    return this.queuedActions.get(key) ?? null;
  }

  /**
   * Check if a player has a pre-action set
   */
  hasPreAction(tableId: string, playerId: string): boolean {
    return this.queuedActions.has(`${tableId}:${playerId}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXECUTION (called when it's the player's turn)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Try to execute the pre-action when a player's turn arrives.
   * Validates the action is still legal given the current game state.
   *
   * @param canCheck - Whether checking is a legal action
   * @param amountToCall - Amount needed to call (0 if can check)
   * @param playerStack - Player's current stack
   * @returns What action to take, or null if no pre-action / invalidated
   */
  executePreAction(
    tableId: string,
    playerId: string,
    canCheck: boolean,
    amountToCall: number,
    playerStack: number
  ): PreActionResult {
    const key = `${tableId}:${playerId}`;
    const entry = this.queuedActions.get(key);
    if (!entry) return { executed: false };

    const fsm = this.getFSM(tableId, playerId);

    // FSM: queued → validating
    fsm.transition('validating');

    /**
     * EVERY pre-action is single-shot (Dan 2026-08-28, reversing the
     * 2026-08-21 "sticky" re-arm).
     *
     * The 2026-08-21 change made fold/check-family pre-actions re-arm after
     * executing so a Check/Fold survived the whole hand. Dan's 2026-08-28
     * report is that this reads as a GLITCH at the table: "the check fold,
     * folds... but then re-appears again after the fold, same bug for check
     * or call any" — the engine kept acting on (and re-surfacing) a choice
     * the player had already watched execute, while the client's own strip
     * showed unarmed. One press, one action: the entry is deleted here,
     * unconditionally, and a player who wants the same pre-action on the
     * next street presses it again — the strip is one tap away and the
     * armed state on screen now always equals the armed state in the
     * engine.
     */
    this.queuedActions.delete(key);

    let action: ActionType | undefined;
    let amount = 0;

    switch (entry.action) {
      case 'auto_fold':
        action = 'fold';
        break;

      case 'auto_check_fold':
        if (canCheck) {
          action = 'check';
        } else {
          action = 'fold';
        }
        break;

      case 'auto_check':
        if (canCheck) {
          action = 'check';
        } else {
          // Bet came in — invalidate the pre-action
          // FSM: validating → invalidated → idle
          fsm.transition('invalidated');
          fsm.transition('idle');
          this.emitEvent({
            type: 'PRE_ACTION_INVALIDATED',
            tableId,
            playerId,
            reason: 'bet_placed',
          });
          return {
            executed: false,
            invalidated: true,
            reason: 'Bet was placed - auto-check cleared',
          };
        }
        break;

      case 'auto_call':
        if (canCheck) {
          action = 'check';
        } else {
          /**
           * A9 FIX (2026-08-20): the cap is checked BEFORE choosing between a
           * normal call and an all-in call.
           *
           * It used to live inside the `amountToCall <= playerStack` branch
           * only, so the one case it most needed to cover skipped it entirely:
           * when the bet exceeded the player's stack, control fell to the `else`
           * and committed `playerStack` — their WHOLE stack — without ever
           * looking at maxCallAmount.
           *
           * A player who pre-set "auto-call up to 50" and then faced a shove had
           * their entire 5,000 committed. A pre-action is a promise about how
           * much of your money may move while you are not looking, and this
           * broke that promise in the most expensive situation there is.
           *
           * The cap now governs both paths. Note it is compared against
           * `amountToCall`, not against the capped amount — a player who agreed
           * to 50 has not agreed to an all-in for 50 against a 5,000 bet; they
           * have declined the hand.
           */
          /**
           * Dan 2026-08-28 (CRITICAL): the effective cap is the LOWER of the
           * client-declared max and the price the player was actually looking
           * at when they armed the button (`toCallAtSet`, recorded by the
           * engine itself at set time). Before this, `maxCallAmount` was the
           * only guard and the client never sent it — so "Call 15" happily
           * called a raise to 65. Now a raise past the armed price ALWAYS
           * invalidates, no matter what the client did or didn't send.
           * `auto_call_any` below remains uncapped by design — that is the
           * button whose label is the promise.
           */
          const effectiveCap = Math.min(
            entry.maxCallAmount ?? Number.POSITIVE_INFINITY,
            entry.toCallAtSet ?? Number.POSITIVE_INFINITY
          );
          if (Number.isFinite(effectiveCap) && amountToCall > effectiveCap) {
            // FSM: validating → invalidated → idle
            fsm.transition('invalidated');
            fsm.transition('idle');
            this.emitEvent({
              type: 'PRE_ACTION_INVALIDATED',
              tableId,
              playerId,
              reason: 'call_exceeds_max',
            });
            return {
              executed: false,
              invalidated: true,
              reason: `Call amount (${amountToCall}) exceeds pre-set max (${effectiveCap})`,
            };
          }
          action = 'call';
          // An all-in call is still a call, just bounded by the stack.
          amount = Math.min(amountToCall, playerStack);
        }
        break;

      case 'auto_call_any':
        if (canCheck) {
          action = 'check';
        } else {
          action = 'call';
          amount = Math.min(amountToCall, playerStack);
        }
        break;

      default:
        // FSM: validating → invalidated → idle (unknown action type)
        fsm.transition('invalidated');
        fsm.transition('idle');
        return { executed: false };
    }

    if (action) {
      // FSM: validating → executing → executed → idle
      fsm.transition('executing');
      fsm.transition('executed');
      this.emitEvent({
        type: 'PRE_ACTION_EXECUTED',
        tableId,
        playerId,
        action,
        amount,
      });
      fsm.transition('idle');
      // No re-arm of any kind — see the single-shot note above the delete.
      return { executed: true, action, amount };
    }

    // FSM: validating → invalidated → idle
    fsm.transition('invalidated');
    fsm.transition('idle');
    return { executed: false };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INVALIDATION (called when game state changes)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Invalidate all auto-check pre-actions when a bet is placed.
   * Called by ServerTableEngine when any player bets or raises.
   */
  onBetPlaced(tableId: string, bettingPlayerId: string): void {
    for (const [key, entry] of this.queuedActions) {
      if (!key.startsWith(`${tableId}:`)) continue;
      if (entry.playerId === bettingPlayerId) continue;

      if (entry.action === 'auto_check') {
        // FSM: queued → idle (invalidated by bet)
        const fsm = this.getFSM(tableId, entry.playerId);
        if (fsm.canTransition('idle')) {
          fsm.transition('idle');
        }

        this.queuedActions.delete(key);
        this.emitEvent({
          type: 'PRE_ACTION_INVALIDATED',
          tableId,
          playerId: entry.playerId,
          reason: 'bet_placed',
        });
      }
    }
  }

  /**
   * Clear all pre-actions for a table (new hand, etc.)
   */
  clearTable(tableId: string): void {
    for (const key of this.queuedActions.keys()) {
      if (key.startsWith(`${tableId}:`)) {
        this.queuedActions.delete(key);
      }
    }
    // Reset all player FSMs for this table back to idle
    for (const [key, fsm] of this.playerFSMs) {
      if (key.startsWith(`${tableId}:`)) {
        fsm.forceState('idle');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Round 64 follow-up: drop one player's queued pre-action + FSM on leave so
   * neither the queue nor the FSM Map accumulates ghost entries. Mirrors
   * DisconnectEngine.unregisterPlayer + TimeBankEngine.removePlayer cleanup.
   * clearTable() runs at hand boundaries but only clears queuedActions, not
   * playerFSMs — this is the per-player hook for that.
   */
  removePlayer(tableId: string, playerId: string): void {
    const key = `${tableId}:${playerId}`;
    this.queuedActions.delete(key);
    this.playerFSMs.delete(key);
  }

  dispose(tableId: string): void {
    this.clearTable(tableId);
    // Clean up FSMs for this table
    for (const key of this.playerFSMs.keys()) {
      if (key.startsWith(`${tableId}:`)) {
        this.playerFSMs.delete(key);
      }
    }
  }

  disposeAll(): void {
    this.queuedActions.clear();
    this.playerFSMs.clear();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE
  // ═══════════════════════════════════════════════════════════════════════════

  private emitEvent(event: PreActionEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch (err) {
        reportError(err, 'PreActionEngine.Event_handler_error');
      }
    }
  }
}
