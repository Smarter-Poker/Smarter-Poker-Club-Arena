/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  STATE VERIFIER — Server-Authoritative Game State Integrity Checker
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Periodic integrity verification of game state:
 * - Chip conservation: sum of stacks + pot = constant throughout hand
 * - No negative stacks
 * - No duplicate cards in play
 * - Community card count matches stage
 * - Active player count consistency
 * - Pot sanity (no negative pot)
 *
 * Called between hands by ServerTableEngine.
 * On any mismatch, logs a critical warning and invokes optional violation callback.
 *
 * Ported from client: src/engine/StateVerifier.ts
 * Server adaptation: No masterBus — uses console logging + optional violation callback.
 */

import type { Card, SeatPlayer, HandStage } from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { createRecoveryStateMachine, type RecoveryFSMState } from './StateMachine.js';
import type { StateMachine } from './StateMachine.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface VerificationContext {
  tableId: string;
  handNumber: number;
  players: SeatPlayer[];
  communityCards: Card[];
  pot: number;
  stage: string; // preflop | flop | turn | river | showdown
  initialChipTotal?: number;
}

export interface IntegrityViolation {
  type: string;
  message: string;
  severity: 'warning' | 'critical';
  details?: Record<string, unknown>;
}

export interface VerificationResult {
  valid: boolean;
  violations: IntegrityViolation[];
  chipTotal: number;
}

export interface ViolationEvent {
  tableId: string;
  handNumber: number;
  violationCount: number;
  violations: { type: string; message: string; severity: string }[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE VERIFIER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class StateVerifier {
  // Track expected chip totals per table
  private chipTotals: Map<string, number> = new Map();
  /** Bible V8 §3.5: Per-table Recovery FSM tracking desync detection → resync → healthy */
  private recoveryFSMs: Map<string, StateMachine<RecoveryFSMState>> = new Map();
  /** Track consecutive failed resync attempts per table (circuit breaker) */
  private resyncRetries: Map<string, number> = new Map();
  private static readonly MAX_RESYNC_RETRIES = 3;
  private onViolation?: (event: ViolationEvent) => void;

  constructor(onViolation?: (event: ViolationEvent) => void) {
    this.onViolation = onViolation;
  }

  /** Get or create the Recovery FSM for a table */
  private getRecoveryFSM(tableId: string): StateMachine<RecoveryFSMState> {
    let fsm = this.recoveryFSMs.get(tableId);
    if (!fsm) {
      fsm = createRecoveryStateMachine('healthy');
      this.recoveryFSMs.set(tableId, fsm);
    }
    return fsm;
  }

  /** Get the current recovery state for a table */
  getRecoveryState(tableId: string): RecoveryFSMState {
    return this.getRecoveryFSM(tableId).state;
  }

  /** Check if a table is in a healthy state */
  isHealthy(tableId: string): boolean {
    return this.getRecoveryFSM(tableId).state === 'healthy';
  }

  /**
   * Record the initial chip total for a hand.
   * Called at the start of each hand with all player stacks summed.
   */
  recordInitialChipTotal(tableId: string, players: SeatPlayer[]): void {
    const total = players.reduce((sum, p) => sum + (p.stack ?? 0), 0);
    this.chipTotals.set(tableId, total);
  }

  /**
   * Deduct rake from the expected chip total for a table.
   * Called after a hand completes so chip conservation check accounts for rake.
   * Without this, every raked hand would false-positive as a chip conservation violation.
   */
  deductRake(tableId: string, rakeAmount: number): void {
    const current = this.chipTotals.get(tableId);
    if (current !== undefined && rakeAmount > 0) {
      this.chipTotals.set(tableId, current - rakeAmount);
    }
  }

  /**
   * Full integrity verification of current game state.
   * Returns all detected violations. Call between hands or during dealing pauses.
   */
  verify(context: VerificationContext): VerificationResult {
    const violations: IntegrityViolation[] = [];

    // 1. Chip Conservation
    this.verifyChipConservation(context, violations);

    // 2. No Negative Stacks
    this.verifyNoNegativeStacks(context, violations);

    // 3. No Duplicate Cards
    this.verifyNoDuplicateCards(context, violations);

    // 4. Community Card Count vs Stage
    this.verifyCommunityCardCount(context, violations);

    // 5. Active Player Count Consistency
    this.verifyPlayerCounts(context, violations);

    // 6. Pot Size Sanity
    this.verifyPotSanity(context, violations);

    // Recovery FSM integration
    const recoveryFSM = this.getRecoveryFSM(context.tableId);
    const hasCritical = violations.some((v) => v.severity === 'critical');

    if (hasCritical && recoveryFSM.state === 'healthy') {
      // FSM: healthy → desync_detected
      recoveryFSM.transition('desync_detected');
      // FSM: desync_detected → resync_required (confirmed critical violation)
      recoveryFSM.transition('resync_required');
    } else if (violations.length === 0 && recoveryFSM.state !== 'healthy') {
      // Violations cleared — if we were in desync_detected, resolve back to healthy
      if (recoveryFSM.canTransition('healthy')) {
        recoveryFSM.transition('healthy');
        this.resyncRetries.delete(context.tableId);
      }
    }

    // Emit violations
    if (violations.length > 0) {
      const event: ViolationEvent = {
        tableId: context.tableId,
        handNumber: context.handNumber,
        violationCount: violations.length,
        violations: violations.map((v) => ({
          type: v.type,
          message: v.message,
          severity: v.severity,
        })),
      };

      reportError(violations.map((v) => `${v.severity.toUpperCase()}: ${v.type} — ${v.message}`).join('; '), 'StateVerifier.violationslength_violations_de');

      if (this.onViolation) {
        try {
          this.onViolation(event);
        } catch (err) {
          reportError(err, 'StateVerifier.Violation_handler_error');
        }
      }
    }

    const chipTotal = context.players.reduce((sum, p) => sum + (p.stack ?? 0), 0) + context.pot;

    return {
      valid: violations.length === 0,
      violations,
      chipTotal,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECOVERY FSM OPERATIONS (Bible V8 §3.5)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Initiate a resync for a table. Called by ServerTableEngine when
   * the recovery FSM reaches 'resync_required'.
   */
  beginResync(tableId: string): boolean {
    const fsm = this.getRecoveryFSM(tableId);
    if (fsm.state !== 'resync_required') return false;
    // FSM: resync_required → resyncing
    return fsm.transition('resyncing');
  }

  /**
   * Mark resync as complete. Called after server has sent fresh state to all clients.
   */
  completeResync(tableId: string): boolean {
    const fsm = this.getRecoveryFSM(tableId);
    if (fsm.state !== 'resyncing') return false;
    // FSM: resyncing → resync_complete → healthy
    fsm.transition('resync_complete');
    fsm.transition('healthy');
    this.resyncRetries.delete(tableId);
    return true;
  }

  /**
   * Mark resync as failed. Retry or escalate to manual intervention.
   */
  failResync(tableId: string): RecoveryFSMState {
    const fsm = this.getRecoveryFSM(tableId);
    if (fsm.state !== 'resyncing') return fsm.state;

    const retries = (this.resyncRetries.get(tableId) ?? 0) + 1;
    this.resyncRetries.set(tableId, retries);

    // FSM: resyncing → recovery_failed
    fsm.transition('recovery_failed');

    if (retries >= StateVerifier.MAX_RESYNC_RETRIES) {
      // FSM: recovery_failed → manual_intervention (circuit breaker)
      fsm.transition('manual_intervention');
      reportError(
        `Table ${tableId} exceeded max resync retries (${retries}). Manual intervention required.`,
        'StateVerifier.MaxResyncRetries'
      );
    } else {
      // FSM: recovery_failed → resync_required (retry)
      fsm.transition('resync_required');
    }

    return fsm.state;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INDIVIDUAL CHECKS
  // ═══════════════════════════════════════════════════════════════════════════

  private verifyChipConservation(
    context: VerificationContext,
    violations: IntegrityViolation[]
  ): void {
    const expectedTotal = context.initialChipTotal ?? this.chipTotals.get(context.tableId);
    if (expectedTotal === undefined) return; // No baseline to compare

    // FIX 204: Only sum stacks — NOT bets. At HAND_COMPLETE, bets are stale artifacts
    // from the last street (not zeroed when hand ends by fold via advanceGame→completeHand
    // instead of advanceStage→completeHand). Those bet chips are already in the pot
    // and distributed to winners, so including them double-counts and causes false positives.
    const currentTotal = context.players.reduce((sum, p) => sum + (p.stack ?? 0), 0);

    // FIX 204b: Widen tolerance from 0.001 to 0.02. After multiple streets of
    // fractional-chip betting (PLO, hi-lo splits, odd-chip allocation), IEEE 754
    // rounding accumulates ~0.003-0.01 per hand. 0.02 catches real chip creation
    // (>1 cent) while ignoring harmless floating-point drift.
    if (Math.abs(currentTotal - expectedTotal) > 0.02) {
      violations.push({
        type: 'CHIP_CONSERVATION',
        message: `Chip total mismatch: expected ${expectedTotal}, got ${currentTotal} (diff: ${currentTotal - expectedTotal})`,
        severity: 'critical',
        details: {
          expected: expectedTotal,
          actual: currentTotal,
          diff: currentTotal - expectedTotal,
          playerStacks: context.players.map((p) => ({
            id: p.user_id,
            stack: p.stack,
            bet: p.bet,
          })),
        },
      });
    }
  }

  private verifyNoNegativeStacks(
    context: VerificationContext,
    violations: IntegrityViolation[]
  ): void {
    for (const player of context.players) {
      if ((player.stack ?? 0) < 0) {
        violations.push({
          type: 'NEGATIVE_STACK',
          message: `Player ${player.user_id} has negative stack: ${player.stack}`,
          severity: 'critical',
          details: { userId: player.user_id, stack: player.stack },
        });
      }
    }
  }

  private verifyNoDuplicateCards(
    context: VerificationContext,
    violations: IntegrityViolation[]
  ): void {
    const allCards: string[] = [];

    // Community cards
    for (const card of context.communityCards) {
      allCards.push(`${card.rank}${card.suit}`);
    }

    // Player hole cards
    for (const player of context.players) {
      if (player.cards) {
        for (const card of player.cards) {
          allCards.push(`${card.rank}${card.suit}`);
        }
      }
    }

    const seen = new Set<string>();
    for (const cardStr of allCards) {
      if (seen.has(cardStr)) {
        violations.push({
          type: 'DUPLICATE_CARD',
          message: `Duplicate card detected: ${cardStr}`,
          severity: 'critical',
          details: { card: cardStr },
        });
      }
      seen.add(cardStr);
    }
  }

  private verifyCommunityCardCount(
    context: VerificationContext,
    violations: IntegrityViolation[]
  ): void {
    const expectedCount: Record<string, number> = {
      preflop: 0,
      flop: 3,
      turn: 4,
      river: 5,
      showdown: 5,
    };

    const expected = expectedCount[context.stage];
    if (expected !== undefined && context.communityCards.length !== expected) {
      violations.push({
        type: 'COMMUNITY_CARD_COUNT',
        message: `Stage ${context.stage} expects ${expected} community cards, got ${context.communityCards.length}`,
        severity: 'warning',
        details: {
          stage: context.stage,
          expected,
          actual: context.communityCards.length,
        },
      });
    }
  }

  private verifyPlayerCounts(
    context: VerificationContext,
    violations: IntegrityViolation[]
  ): void {
    const nonFolded = context.players.filter((p) => !p.is_folded).length;
    const allIn = context.players.filter((p) => p.is_all_in).length;
    const active = nonFolded - allIn;

    // At least 1 non-folded player should exist during a hand
    if (nonFolded === 0 && context.stage !== 'showdown') {
      violations.push({
        type: 'NO_ACTIVE_PLAYERS',
        message: 'All players are folded but hand is not at showdown',
        severity: 'warning',
        details: { nonFolded, allIn, active, stage: context.stage },
      });
    }
  }

  private verifyPotSanity(
    context: VerificationContext,
    violations: IntegrityViolation[]
  ): void {
    if (context.pot < 0) {
      violations.push({
        type: 'NEGATIVE_POT',
        message: `Pot is negative: ${context.pot}`,
        severity: 'critical',
        details: { pot: context.pot },
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════

  clearTable(tableId: string): void {
    this.chipTotals.delete(tableId);
    this.recoveryFSMs.delete(tableId);
    this.resyncRetries.delete(tableId);
  }

  dispose(): void {
    this.chipTotals.clear();
    this.recoveryFSMs.clear();
    this.resyncRetries.clear();
  }
}
