/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SERVER ACTION VALIDATOR — Server-Authoritative Action Validation
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Validates every player action before it is applied to game state:
 * - Action legality (can they check/fold/raise in this context?)
 * - Amount bounds (min raise, max raise, stack sufficiency)
 * - Turn order (is it actually this player's turn?)
 * - Timing (action submitted within time limit)
 * - Duplicate suppression (reject if player already acted this round)
 *
 * Returns sanitized action data or rejection with reason.
 *
 * Ported from client: src/engine/ServerActionValidator.ts
 * Server adaptation: No masterBus — uses console logging + optional rejection callback.
 */

import type { ActionType } from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { isWholeTournamentChip, TOURNAMENT_WHOLE_CHIP_ERROR } from './TournamentChipIntegrity.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ActionRequest {
  tableId: string;
  handId: string;
  playerId: string;
  action: ActionType;
  amount?: number;
  timestamp: number; // Client-sent timestamp (ms)
}

export interface ValidationContext {
  /** Tournament wagers and every state value they are derived from are whole-chip only. */
  isTournament?: boolean;
  currentPlayerId: string; // Whose turn it is
  stage: string; // preflop | flop | turn | river
  currentBet: number; // Current highest bet
  playerBet: number; // Player's current bet this street
  playerStack: number; // Player's remaining stack
  bigBlind: number;
  minRaise: number; // Minimum legal raise amount
  pot: number;
  canCheck: boolean; // Is check a legal action?
  actionDeadline: number; // Timestamp (ms) when timer expires
  playerActedThisRound: boolean; // Has this player already taken action?
  isAllIn: boolean; // Is the player already all-in?
  isFolded: boolean; // Has the player already folded?
  numActivePlayers: number; // Non-folded, non-all-in players
}

export interface ValidationResult {
  valid: boolean;
  sanitizedAction?: ActionType;
  sanitizedAmount?: number;
  reason?: string;
  code?: ValidationErrorCode;
  hint?: Record<string, unknown>; // Hint data for UI auto-correction
}

export type ValidationErrorCode =
  | 'NOT_YOUR_TURN'
  | 'ALREADY_ACTED'
  | 'ALREADY_FOLDED'
  | 'ALREADY_ALL_IN'
  | 'ACTION_EXPIRED'
  | 'INVALID_ACTION'
  | 'INSUFFICIENT_STACK'
  | 'BELOW_MIN_RAISE'
  | 'ABOVE_MAX_RAISE'
  | 'CANNOT_CHECK'
  | 'NOTHING_TO_CALL'
  | 'INVALID_AMOUNT';

export interface RejectionEvent {
  tableId: string;
  playerId: string;
  code: ValidationErrorCode;
  reason: string;
  timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATOR CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class ServerActionValidator {
  // Track last action per player to suppress duplicates
  private lastActionIds: Map<string, string> = new Map();
  private onRejection?: (event: RejectionEvent) => void;

  constructor(onRejection?: (event: RejectionEvent) => void) {
    this.onRejection = onRejection;
  }

  /**
   * Validate an action request against the current game context.
   * Returns a sanitized result or rejection with reason.
   */
  validate(request: ActionRequest, context: ValidationContext): ValidationResult {
    const { tableId, handId, playerId, action, amount, timestamp } = request;

    // ── 1. Turn Order Check ──
    if (playerId !== context.currentPlayerId) {
      return this.reject('NOT_YOUR_TURN', `It is not ${playerId}'s turn`, tableId, playerId);
    }

    // ── 2. Player State Checks ──
    if (context.isFolded) {
      return this.reject('ALREADY_FOLDED', 'Player has already folded', tableId, playerId);
    }

    if (context.isAllIn) {
      return this.reject('ALREADY_ALL_IN', 'Player is already all-in', tableId, playerId);
    }

    if (context.isTournament) {
      // Validate the raw request and authoritative context before min/max
      // sanitization. A 4.5-chip request must not become some different legal
      // integer wager, and a fractional live state must stop rather than be
      // rounded into a different pot.
      if (amount !== undefined && !isWholeTournamentChip(amount)) {
        return this.reject(
          'INVALID_AMOUNT',
          `${TOURNAMENT_WHOLE_CHIP_ERROR}: requestedWager=${String(amount)}`,
          tableId,
          playerId
        );
      }
      const stateAmounts: Array<[string, number]> = [
        ['currentBet', context.currentBet],
        ['playerBet', context.playerBet],
        ['playerStack', context.playerStack],
        ['bigBlind', context.bigBlind],
        ['minRaise', context.minRaise],
        ['pot', context.pot],
      ];
      const invalidState = stateAmounts.find(([, value]) => !isWholeTournamentChip(value));
      if (invalidState) {
        return this.reject(
          'INVALID_AMOUNT',
          `${TOURNAMENT_WHOLE_CHIP_ERROR}: context.${invalidState[0]}=${String(invalidState[1])}`,
          tableId,
          playerId
        );
      }
    }

    // ── 3. Duplicate Suppression ──
    const actionKey = `${tableId}:${playerId}`;
    const actionId = `${handId}:${action}:${amount ?? 0}:${timestamp}`;
    if (this.lastActionIds.get(actionKey) === actionId) {
      return this.reject('ALREADY_ACTED', 'Duplicate action suppressed', tableId, playerId);
    }

    // ── 4. Timing Check ──
    const now = Date.now();
    // Allow 2-second grace period for network latency
    if (context.actionDeadline > 0 && now > context.actionDeadline + 2000) {
      return this.reject('ACTION_EXPIRED', 'Action submitted after time limit', tableId, playerId);
    }

    // ── 5. Action-Specific Validation ──
    let result: ValidationResult;

    switch (action) {
      case 'fold':
        result = this.validateFold();
        break;
      case 'check':
        result = this.validateCheck(context);
        break;
      case 'call':
        result = this.validateCall(context);
        break;
      case 'bet':
        result = this.validateBet(amount, context);
        break;
      case 'raise':
        result = this.validateRaise(amount, context);
        break;
      case 'all_in':
        result = this.validateAllIn(context);
        break;
      default:
        result = this.reject('INVALID_ACTION', `Unknown action: ${action}`, tableId, playerId);
    }

    // Record successful action for duplicate suppression
    if (result.valid) {
      this.lastActionIds.set(actionKey, actionId);
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ACTION VALIDATORS
  // ═══════════════════════════════════════════════════════════════════════════

  private validateFold(): ValidationResult {
    // Fold is always valid (player may fold even when they can check)
    return { valid: true, sanitizedAction: 'fold' };
  }

  private validateCheck(context: ValidationContext): ValidationResult {
    if (!context.canCheck) {
      return {
        valid: false,
        reason: 'Cannot check when there is a bet to call',
        code: 'CANNOT_CHECK',
        hint: {
          suggestedAction: 'call',
          suggestedAmount: context.currentBet - context.playerBet,
        },
      };
    }
    return { valid: true, sanitizedAction: 'check' };
  }

  private validateCall(context: ValidationContext): ValidationResult {
    const toCall = context.currentBet - context.playerBet;
    if (toCall <= 0) {
      return { valid: false, reason: 'Nothing to call', code: 'NOTHING_TO_CALL' };
    }

    // If calling would put player all-in, sanitize to all_in
    if (toCall >= context.playerStack) {
      return {
        valid: true,
        sanitizedAction: 'all_in',
        sanitizedAmount: context.playerStack,
      };
    }

    return { valid: true, sanitizedAction: 'call', sanitizedAmount: toCall };
  }

  private validateBet(amount: number | undefined, context: ValidationContext): ValidationResult {
    if (context.currentBet > 0) {
      return {
        valid: false,
        reason: 'Cannot bet when there is already a bet (use raise)',
        code: 'INVALID_ACTION',
      };
    }

    if (!amount || amount <= 0) {
      return { valid: false, reason: 'Bet amount required', code: 'INVALID_AMOUNT' };
    }

    // Min bet = big blind
    if (amount < context.bigBlind && amount < context.playerStack) {
      return {
        valid: false,
        reason: `Minimum bet is ${context.bigBlind}`,
        code: 'BELOW_MIN_RAISE',
        hint: {
          suggestedAction: 'bet',
          suggestedAmount: context.bigBlind,
        },
      };
    }

    // All-in if amount >= stack
    if (amount >= context.playerStack) {
      return {
        valid: true,
        sanitizedAction: 'all_in',
        sanitizedAmount: context.playerStack,
      };
    }

    return { valid: true, sanitizedAction: 'bet', sanitizedAmount: amount };
  }

  private validateRaise(amount: number | undefined, context: ValidationContext): ValidationResult {
    if (context.currentBet <= 0) {
      return {
        valid: false,
        reason: 'Cannot raise when there is no bet (use bet)',
        code: 'INVALID_ACTION',
      };
    }

    if (!amount || amount <= 0) {
      return { valid: false, reason: 'Raise amount required', code: 'INVALID_AMOUNT' };
    }

    const maxRaiseTo = context.playerBet + context.playerStack;
    const raiseIncrement = amount - context.currentBet;

    // All-in: always valid (even if below min raise)
    if (amount >= maxRaiseTo) {
      return {
        valid: true,
        sanitizedAction: 'all_in',
        sanitizedAmount: context.playerStack,
      };
    }

    // Must raise at least the minimum
    if (raiseIncrement < context.minRaise) {
      return {
        valid: false,
        reason: `Minimum raise is ${context.minRaise} (raise to at least ${context.currentBet + context.minRaise})`,
        code: 'BELOW_MIN_RAISE',
        hint: {
          suggestedAction: 'raise',
          suggestedAmount: context.currentBet + context.minRaise,
        },
      };
    }

    // Insufficient stack
    const cost = amount - context.playerBet;
    if (cost > context.playerStack) {
      return { valid: false, reason: 'Insufficient chips', code: 'INSUFFICIENT_STACK' };
    }

    return { valid: true, sanitizedAction: 'raise', sanitizedAmount: amount };
  }

  private validateAllIn(context: ValidationContext): ValidationResult {
    if (context.playerStack <= 0) {
      return {
        valid: false,
        reason: 'No chips to go all-in with',
        code: 'INSUFFICIENT_STACK',
      };
    }

    return {
      valid: true,
      sanitizedAction: 'all_in',
      sanitizedAmount: context.playerStack,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  private reject(
    code: ValidationErrorCode,
    reason: string,
    tableId: string,
    playerId: string
  ): ValidationResult {
    const event: RejectionEvent = {
      tableId,
      playerId,
      code,
      reason,
      timestamp: Date.now(),
    };

    console.warn(
      `[ServerActionValidator] Rejected ${code}: ${reason} (table=${tableId}, player=${playerId})`
    );

    if (this.onRejection) {
      try {
        this.onRejection(event);
      } catch (err) {
        reportError(err, 'ServerActionValidator.Rejection_handler_error');
      }
    }

    return { valid: false, reason, code };
  }

  /**
   * Clear tracked actions for a table (call between hands).
   */
  clearTable(tableId: string): void {
    for (const key of [...this.lastActionIds.keys()]) {
      if (key.startsWith(`${tableId}:`)) {
        this.lastActionIds.delete(key);
      }
    }
  }

  /**
   * Clear all state.
   */
  dispose(): void {
    this.lastActionIds.clear();
  }
}
