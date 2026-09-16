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
  /**
   * RIT VERIFIER FIX 2026-08-21: boards dealt by Run It Twice this hand
   * (0/undefined = normal hand). Multi-board hands legitimately keep only
   * the shared pre-all-in prefix in communityCards — each full board lives
   * in the RIT runout's own arrays and is guaranteed 5 cards there.
   */
  ritBoards?: number;
  initialChipTotal?: number;
  /**
   * A7 FIX (2026-07-28): which point of the hand this snapshot was taken at.
   * It selects the conservation equation, because the two points are genuinely
   * different accounting states:
   *
   *   'in_hand'       chips are split between stacks and the pot, and nothing
   *                   has been raked yet, so the invariant is
   *                       Σ stacks + pot + rakeTaken === initial
   *                   Committed bets are ALREADY inside `pot` (HandController
   *                   adds to `state.pot` at the moment a chip is committed),
   *                   so `bet` must NOT be added again.
   *
   *   'hand_complete' the pot has been distributed back into stacks and the
   *                   rake has been removed, so the invariant is
   *                       Σ stacks === initial - rake
   *                   (`initial` here is the baseline already reduced by
   *                   deductRake()). `bet` at this point is a stale artifact of
   *                   the last street — see FIX 204.
   *
   * Defaults to 'hand_complete' so every pre-existing caller keeps its exact
   * current semantics.
   */
  phase?: VerificationPhase;
  /**
   * A7: rake + BBJ fee already taken OUT of the pot at the moment of this
   * snapshot. Only relevant for 'in_hand'; at 'hand_complete' the rake is
   * accounted for by deductRake() against the stored baseline instead.
   */
  rakeTaken?: number;
}

export type VerificationPhase = 'in_hand' | 'hand_complete';

export interface IntegrityViolation {
  type: string;
  message: string;
  severity: 'warning' | 'critical';
  details?: Record<string, unknown>;
}

export interface VerificationResult {
  valid: boolean;
  violations: IntegrityViolation[];
  /**
   * A7 FIX: this is now the SAME quantity the conservation check compared —
   * it used to be `Σ stacks + pot` unconditionally while the check looked at
   * `Σ stacks` alone, so a caller that logged `chipTotal` was reading a number
   * that could not be reconciled with the verdict next to it.
   */
  chipTotal: number;
  /** The baseline `chipTotal` was compared against (undefined = no baseline). */
  expectedChipTotal?: number;
  /** chipTotal - expectedChipTotal, or undefined when there is no baseline. */
  drift?: number;
  phase: VerificationPhase;
}

export interface ViolationEvent {
  tableId: string;
  handNumber: number;
  violationCount: number;
  violations: { type: string; message: string; severity: string }[];
}

/**
 * A7: shared tolerance for every chip comparison. Large enough to swallow the
 * IEEE 754 drift that multi-street fractional betting accumulates (~0.003-0.01
 * per hand), small enough that anything above one cent is a real defect.
 */
const CHIP_TOLERANCE = 0.02;

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
    const phase: VerificationPhase = context.phase ?? 'hand_complete';

    // 1. Chip Conservation
    this.verifyChipConservation(context, violations);

    // 1b. A7: pot === Σ contributions. Catches chips appearing in (or leaking
    //     out of) the pot WITHIN a street, which the stacks-only check at
    //     HAND_COMPLETE cannot see because by then the pot is already gone.
    this.verifyPotAccounting(context, violations);

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

      reportError(
        violations.map((v) => `${v.severity.toUpperCase()}: ${v.type} - ${v.message}`).join('; '),
        'StateVerifier.violationslength_violations_de'
      );

      if (this.onViolation) {
        try {
          this.onViolation(event);
        } catch (err) {
          reportError(err, 'StateVerifier.Violation_handler_error');
        }
      }
    }

    // A7: report exactly what was measured, and against what.
    const chipTotal = this.liveChipTotal(context);
    const expectedChipTotal = this.expectedTotalFor(context);

    return {
      valid: violations.length === 0,
      violations,
      chipTotal,
      expectedChipTotal,
      drift:
        expectedChipTotal === undefined
          ? undefined
          : Math.round((chipTotal - expectedChipTotal) * 100) / 100,
      phase,
    };
  }

  /** The baseline this table's chips are measured against, if one was recorded. */
  getExpectedChipTotal(tableId: string): number | undefined {
    return this.chipTotals.get(tableId);
  }

  /**
   * A7: every chip currently in play, expressed so that it is directly
   * comparable to the recorded baseline for the given phase.
   */
  private liveChipTotal(context: VerificationContext): number {
    const stacks = context.players.reduce((sum, p) => sum + (p.stack ?? 0), 0);
    if ((context.phase ?? 'hand_complete') === 'in_hand') {
      // Bets are already inside `pot` — adding them would double-count.
      return Math.round((stacks + context.pot + (context.rakeTaken ?? 0)) * 100) / 100;
    }
    // FIX 204: at HAND_COMPLETE the pot is distributed and `bet` is stale.
    return Math.round(stacks * 100) / 100;
  }

  private expectedTotalFor(context: VerificationContext): number | undefined {
    return context.initialChipTotal ?? this.chipTotals.get(context.tableId);
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

  /**
   * A7 FIX (2026-07-28): chip conservation, now valid at BOTH points of the hand.
   *
   * Previously this only ever ran at HAND_COMPLETE and only summed stacks, so
   * chips minted or destroyed *inside* a street were completely invisible: they
   * lived in the pot, and by the time the check ran the pot had already been
   * paid out, folding the error into the winner's stack where it looked like a
   * legitimate win. Running with phase 'in_hand' at every street transition is
   * what actually closes that hole.
   */
  private verifyChipConservation(
    context: VerificationContext,
    violations: IntegrityViolation[]
  ): void {
    const expectedTotal = this.expectedTotalFor(context);
    if (expectedTotal === undefined) return; // No baseline to compare

    const phase: VerificationPhase = context.phase ?? 'hand_complete';
    const currentTotal = this.liveChipTotal(context);

    // FIX 204b: Tolerance 0.02. After multiple streets of fractional-chip
    // betting (PLO, hi-lo splits, odd-chip allocation), IEEE 754 rounding
    // accumulates ~0.003-0.01 per hand. 0.02 catches real chip creation
    // (>1 cent) while ignoring harmless floating-point drift.
    if (Math.abs(currentTotal - expectedTotal) > CHIP_TOLERANCE) {
      const diff = Math.round((currentTotal - expectedTotal) * 100) / 100;
      violations.push({
        type: 'CHIP_CONSERVATION',
        message: `Chip total mismatch (${phase}): expected ${expectedTotal}, got ${currentTotal} (diff: ${diff})`,
        severity: 'critical',
        details: {
          phase,
          stage: context.stage,
          expected: expectedTotal,
          actual: currentTotal,
          diff,
          pot: context.pot,
          rakeTaken: context.rakeTaken ?? 0,
          playerStacks: context.players.map((p) => ({
            id: p.user_id,
            stack: p.stack,
            bet: p.bet,
            totalInvested: p.totalInvested,
          })),
        },
      });
    }
  }

  /**
   * A7 FIX (2026-07-28): pot === Σ contributions.
   *
   * `HandController` moves chips into `state.pot` and into the contributing
   * player's `totalInvested` in the same breath (blinds, antes, straddles,
   * calls, raises, all-ins — and the uncalled-bet return decrements both), so
   * the two must stay equal for the whole hand, modulo any rake already pulled
   * out. A divergence means chips entered or left the pot without a player
   * paying or being paid: the exact signature of in-street chip creation.
   *
   * Only meaningful before the pot is distributed, so it is skipped at
   * 'hand_complete' (where pot is 0 but contributions are the hand's history).
   */
  private verifyPotAccounting(
    context: VerificationContext,
    violations: IntegrityViolation[]
  ): void {
    if ((context.phase ?? 'hand_complete') !== 'in_hand') return;

    const contributions = context.players.reduce((sum, p) => sum + (p.totalInvested ?? 0), 0);
    const accounted = Math.round((context.pot + (context.rakeTaken ?? 0)) * 100) / 100;

    if (Math.abs(accounted - contributions) > CHIP_TOLERANCE) {
      const diff = Math.round((accounted - contributions) * 100) / 100;
      violations.push({
        type: 'POT_ACCOUNTING',
        message: `Pot does not match contributions at ${context.stage}: pot+rake ${accounted}, Σ totalInvested ${contributions} (diff: ${diff})`,
        severity: 'critical',
        details: {
          stage: context.stage,
          pot: context.pot,
          rakeTaken: context.rakeTaken ?? 0,
          contributions,
          diff,
          perPlayer: context.players.map((p) => ({
            id: p.user_id,
            bet: p.bet,
            totalInvested: p.totalInvested,
            folded: p.is_folded,
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
      // A7: a negative bet or a negative contribution is chip creation with a
      // minus sign in front of it — the conservation sums would quietly absorb
      // it, so name it explicitly.
      if ((player.bet ?? 0) < 0) {
        violations.push({
          type: 'NEGATIVE_BET',
          message: `Player ${player.user_id} has negative bet: ${player.bet}`,
          severity: 'critical',
          details: { userId: player.user_id, bet: player.bet },
        });
      }
      if ((player.totalInvested ?? 0) < 0) {
        violations.push({
          type: 'NEGATIVE_CONTRIBUTION',
          message: `Player ${player.user_id} has negative totalInvested: ${player.totalInvested}`,
          severity: 'critical',
          details: { userId: player.user_id, totalInvested: player.totalInvested },
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
    if (expected === undefined) return;

    const actual = context.communityCards.length;
    if (actual === expected) return;

    // ── 2026-08-17: direction matters, and only one direction is a fault ──
    //
    // This was a strict inequality and it fired on 236 DISTINCT HANDS PER HOUR
    // in production — every observed instance being `actual > expected` with
    // actual <= 5, e.g. "Stage flop expects 3 community cards, got 5".
    //
    // That is an all-in runout (also run-it-twice / rabbit hunt): the board is
    // dealt to completion while `stage` still reads flop or turn. The cards are
    // right, the LABEL lags. Nothing about it is a fairness or money problem.
    //
    // Meanwhile the direction that IS a fault — a board with FEWER cards than
    // the street requires, i.e. a river played on four cards — was
    // indistinguishable from that flood. At 236/hour the warning was pure
    // noise, and noise is what buries a real CHIP_CONSERVATION or
    // DUPLICATE_CARD event. An integrity monitor nobody can act on is worse
    // than none: it manufactures the feeling of coverage.
    //
    // So flag a board that is BEHIND its street (cards missing), or one that
    // exceeds five cards (impossible in any variant dealt here). A board that
    // has merely run AHEAD of its stage label is expected during a runout and
    // is no longer reported. Deliberately a rule about direction rather than an
    // inference about all-in state: it cannot be wrong about what it suppresses.
    const MAX_BOARD = 5;

    if (actual > MAX_BOARD) {
      violations.push({
        type: 'COMMUNITY_CARD_COUNT',
        message: `Stage ${context.stage} has ${actual} community cards - more than a full board (${MAX_BOARD})`,
        severity: 'critical',
        details: { stage: context.stage, expected, actual, reason: 'board_overflow' },
      });
      return;
    }

    if (actual < expected) {
      // RIT VERIFIER FIX 2026-08-21: a hand resolved across 2-3 boards keeps
      // only the shared pre-all-in prefix here (0 for a preflop all-in, 4
      // for a turn all-in) while the stage reads 'showdown'. That is the
      // DESIGNED shape, not a missing board — every RIT board is dealt to a
      // full 5 in the runout (2026-08-18 rake-fix invariant). Reporting it
      // was pure noise that would bury a real violation.
      if ((context.ritBoards ?? 0) >= 2) return;
      violations.push({
        type: 'COMMUNITY_CARD_COUNT',
        message: `Stage ${context.stage} expects ${expected} community cards, got only ${actual} - cards are missing`,
        severity: 'warning',
        details: { stage: context.stage, expected, actual, reason: 'board_behind_stage' },
      });
    }

    // actual > expected && actual <= MAX_BOARD: board ahead of the stage label.
    // Benign runout artefact — deliberately not reported.
  }

  private verifyPlayerCounts(context: VerificationContext, violations: IntegrityViolation[]): void {
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

  private verifyPotSanity(context: VerificationContext, violations: IntegrityViolation[]): void {
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
