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
  private onViolation?: (event: ViolationEvent) => void;

  constructor(onViolation?: (event: ViolationEvent) => void) {
    this.onViolation = onViolation;
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

      console.error(
        `[StateVerifier] ${violations.length} violation(s) detected for table ${context.tableId}, hand #${context.handNumber}:`,
        violations.map((v) => `${v.severity.toUpperCase()}: ${v.type} — ${v.message}`).join('; ')
      );

      if (this.onViolation) {
        try {
          this.onViolation(event);
        } catch (err) {
          console.error('[StateVerifier] Violation handler error:', err);
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
  // INDIVIDUAL CHECKS
  // ═══════════════════════════════════════════════════════════════════════════

  private verifyChipConservation(
    context: VerificationContext,
    violations: IntegrityViolation[]
  ): void {
    const expectedTotal = context.initialChipTotal ?? this.chipTotals.get(context.tableId);
    if (expectedTotal === undefined) return; // No baseline to compare

    const currentTotal = context.players.reduce((sum, p) => sum + (p.stack ?? 0) + (p.bet ?? 0), 0);

    // Allow floating-point rounding tolerance (supports fractional chips)
    if (Math.abs(currentTotal - expectedTotal) > 0.001) {
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
  }

  dispose(): void {
    this.chipTotals.clear();
  }
}
