import { reportError } from '../services/errorReporter.js';
import { deadlineScheduler, type DeadlineScheduler } from './DeadlineScheduler.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RUN IT TWICE ENGINE — Dual-Board Card Dealing for All-In Scenarios
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Handles the complete Run It Twice (RIT) lifecycle:
 * - Detects all-in scenarios where RIT can be offered
 * - Manages accept/decline responses from both players
 * - Deals two (or three) independent board runouts
 * - Calculates pot division based on dual board results
 * - Optional event callbacks for UI synchronization
 *
 * Ported from client: src/engine/RunItTwiceEngine.ts (316 lines)
 * Server adaptation: No masterBus — uses optional onEvent callback. Class export, not singleton.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface RITConfig {
  enabled: boolean;
  autoDeclineTimeout: number;
  maxRuns: 2 | 3;
  /** FIX 96: Timeout for chooser to pick runs (phase 1) */
  chooserTimeout?: number;
  /** FIX 96: Timeout for others to accept/decline (phase 2) */
  responderTimeout?: number;
}

export interface RITState {
  tableId: string;
  handId: string;
  status: 'idle' | 'offered' | 'accepted' | 'declined' | 'resolved';
  offeredBy: string;
  offeredTo: string;
  /** FIX 96: All player IDs involved in the all-in (for multi-player RIT) */
  allPlayerIds: string[];
  /** FIX 96: Player who chooses the number of runs */
  chooserPlayerId?: string;
  acceptedBy: Set<string>;
  pot: number;
  maxRuns: 2 | 3;
  /** FIX 96: Chosen number of runs (set by chooser in phase 1) */
  chosenRuns: 1 | 2 | 3;
  board1: string[];
  board2: string[];
  board3: string[];
  board1Winner?: string;
  board2Winner?: string;
  board3Winner?: string;
  // Phase 1.2 PR-G-real: timeouts routed through DeadlineScheduler keyed by
  // eventId = 'rit_offer' on the state's tableId. Raw setTimeout handle deleted.
}

export interface RITResult {
  board1: string[];
  board2: string[];
  board3?: string[];
  pot1: number;
  pot2: number;
  pot3?: number;
  board1Winner: string;
  board2Winner: string;
  board3Winner?: string;
}

export type RITEventType = 'RIT_OFFERED' | 'RIT_ACCEPTED' | 'RIT_DECLINED' | 'RIT_RESOLVED';

export interface RITEvent {
  type: RITEventType;
  tableId: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUN IT TWICE ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class RunItTwiceEngine {
  private activeOffers: Map<string, RITState> = new Map();
  private tableConfigs: Map<string, RITConfig> = new Map();
  private onEvent?: (event: RITEvent) => void;
  /**
   * Phase 1.2 PR-G-real: central scheduler used for offer expiry. Replaces
   * the per-state setTimeout handle. One DeadlineScheduler tick per process
   * fires every expiring RIT offer across every table.
   */
  private scheduler: DeadlineScheduler;

  private static readonly OFFER_EVENT_ID = 'rit_offer';

  constructor(
    onEvent?: (event: RITEvent) => void,
    scheduler: DeadlineScheduler = deadlineScheduler
  ) {
    this.onEvent = onEvent;
    this.scheduler = scheduler;
    this.scheduler.start();
  }

  configure(tableId: string, config: RITConfig): void {
    this.tableConfigs.set(tableId, config);
  }

  isEnabled(tableId: string): boolean {
    return this.tableConfigs.get(tableId)?.enabled ?? false;
  }

  /**
   * Offer RIT when all-in is detected.
   * Called by ServerTableEngine when 2+ players are all-in.
   */
  offer(
    tableId: string,
    handId: string,
    offeredBy: string,
    offeredTo: string | string[],
    pot: number
  ): void {
    const config = this.tableConfigs.get(tableId);
    if (!config?.enabled) return;

    this.clearOffer(tableId);

    // Support both single player (string) and multi-player (string[]) for backward compatibility
    const allPlayerIds = Array.isArray(offeredTo) ? offeredTo : [offeredBy, offeredTo];
    const primaryOfferedTo = Array.isArray(offeredTo)
      ? offeredTo.find((id) => id !== offeredBy) || offeredTo[0]
      : offeredTo;

    const state: RITState = {
      tableId,
      handId,
      status: 'offered',
      offeredBy,
      offeredTo: primaryOfferedTo,
      allPlayerIds,
      chooserPlayerId: offeredBy,
      acceptedBy: new Set([offeredBy]),
      pot,
      maxRuns: config.maxRuns || 2,
      chosenRuns: config.maxRuns || 2,
      board1: [],
      board2: [],
      board3: [],
    };

    // Phase 1.2 PR-G-real: replace setTimeout with DeadlineScheduler entry.
    this.scheduler.schedule({
      tableId,
      eventId: RunItTwiceEngine.OFFER_EVENT_ID,
      deadlineMs: Date.now() + (config.autoDeclineTimeout || 10) * 1000,
      callback: () => {
        if (state.status === 'offered') {
          this.decline(tableId, primaryOfferedTo);
        }
      },
    });

    this.activeOffers.set(tableId, state);

    this.emitEvent({
      type: 'RIT_OFFERED',
      tableId,
      handId,
      offeredBy,
      offeredTo: primaryOfferedTo,
      allPlayerIds,
      pot,
    });
  }

  accept(tableId: string, playerId: string): boolean {
    const state = this.activeOffers.get(tableId);
    if (!state || state.status !== 'offered') return false;

    state.acceptedBy.add(playerId);

    if (state.acceptedBy.has(state.offeredBy) && state.acceptedBy.has(state.offeredTo)) {
      state.status = 'accepted';
      // Phase 1.2 PR-G-real: cancel pending expiry deadline.
      this.scheduler.cancel(tableId, RunItTwiceEngine.OFFER_EVENT_ID);

      this.emitEvent({
        type: 'RIT_ACCEPTED',
        tableId,
        handId: state.handId,
      });
      return true;
    }

    return false;
  }

  decline(tableId: string, playerId: string): void {
    const state = this.activeOffers.get(tableId);
    if (!state || state.status !== 'offered') return;

    state.status = 'declined';
    // Phase 1.2 PR-G-real: cancel pending expiry deadline.
    this.scheduler.cancel(tableId, RunItTwiceEngine.OFFER_EVENT_ID);

    this.emitEvent({
      type: 'RIT_DECLINED',
      tableId,
      handId: state.handId,
      declinedBy: playerId,
    });
  }

  /**
   * Deal two (or three) independent boards from the remaining deck.
   */
  dealDualBoards(
    tableId: string,
    remainingDeck: string[],
    existingBoard: string[]
  ): RITResult | null {
    const state = this.activeOffers.get(tableId);
    if (!state || state.status !== 'accepted') return null;

    // FIX 171: Use chosenRuns (set by chooser in FIX 96) instead of maxRuns.
    // If chooser picked 2 runs but maxRuns is 3, we should deal 2 boards, not 3.
    const runs = state.chosenRuns || state.maxRuns || 2;
    const cardsNeeded = 5 - existingBoard.length;
    if (remainingDeck.length < cardsNeeded * runs) {
      reportError(new Error(`[RunItTwiceEngine] Not enough cards for ${runs} runouts at ${tableId}`), 'RunItTwiceEngine.Not_enough_cards_for_runs_runo');
      return null;
    }

    const run1Cards = remainingDeck.slice(0, cardsNeeded);
    const run2Cards = remainingDeck.slice(cardsNeeded, cardsNeeded * 2);
    state.board1 = [...existingBoard, ...run1Cards];
    state.board2 = [...existingBoard, ...run2Cards];

    const result: RITResult = {
      board1: state.board1,
      board2: state.board2,
      pot1: 0,
      pot2: 0,
      board1Winner: '',
      board2Winner: '',
    };

    if (runs === 3) {
      const run3Cards = remainingDeck.slice(cardsNeeded * 2, cardsNeeded * 3);
      state.board3 = [...existingBoard, ...run3Cards];
      result.board3 = state.board3;
      const third = Math.trunc((state.pot / 3) * 100) / 100;
      result.pot1 = third;
      result.pot2 = third;
      result.pot3 = state.pot - third * 2;
      result.board3Winner = '';
    } else {
      result.pot1 = Math.trunc((state.pot / 2) * 100) / 100;
      result.pot2 = state.pot - result.pot1;
    }

    return result;
  }

  /**
   * Resolve RIT with board winners (called after hand evaluation)
   */
  resolve(
    tableId: string,
    board1Winner: string,
    board2Winner: string,
    board3Winner?: string
  ): Map<string, number> {
    const state = this.activeOffers.get(tableId);
    if (!state) return new Map();

    state.board1Winner = board1Winner;
    state.board2Winner = board2Winner;
    if (board3Winner) state.board3Winner = board3Winner;
    state.status = 'resolved';

    const distribution = new Map<string, number>();
    // FIX 171: Use chosenRuns for consistency with dealDualBoards
    const runs = state.chosenRuns || state.maxRuns || 2;

    if (runs === 3 && board3Winner) {
      const third = Math.trunc((state.pot / 3) * 100) / 100;
      const remainder = state.pot - third * 2;

      const winners = [board1Winner, board2Winner, board3Winner];
      const amounts = [third, third, remainder];

      for (let i = 0; i < 3; i++) {
        distribution.set(winners[i], (distribution.get(winners[i]) || 0) + amounts[i]);
      }
    } else {
      const halfPot = Math.trunc((state.pot / 2) * 100) / 100;
      const otherHalf = state.pot - halfPot;

      if (board1Winner === board2Winner) {
        distribution.set(board1Winner, state.pot);
      } else {
        distribution.set(board1Winner, halfPot);
        distribution.set(board2Winner, otherHalf);
      }
    }

    this.emitEvent({
      type: 'RIT_RESOLVED',
      tableId,
      handId: state.handId,
      board1: state.board1,
      board2: state.board2,
      board1Winner,
      board2Winner,
      distribution: Object.fromEntries(distribution),
    });

    this.clearOffer(tableId);
    return distribution;
  }

  isActive(tableId: string): boolean {
    const state = this.activeOffers.get(tableId);
    return state?.status === 'accepted';
  }

  getState(tableId: string): RITState | null {
    return this.activeOffers.get(tableId) ?? null;
  }

  /**
   * FIX 96: Get the chosen number of runs for a table.
   * Returns state.chosenRuns (set by chooser), falls back to maxRuns config.
   */
  getChosenRuns(tableId: string): number {
    const state = this.activeOffers.get(tableId);
    if (state) return state.chosenRuns;
    const config = this.tableConfigs.get(tableId);
    return config?.maxRuns ?? 2;
  }

  /**
   * FIX 96: Chooser decides how many runs (1, 2, or 3).
   */
  setChosenRuns(tableId: string, runs: 1 | 2 | 3): void {
    const state = this.activeOffers.get(tableId);
    if (state) state.chosenRuns = runs;
  }

  /**
   * FIX 96: Check if there's a pending (offered) RIT for this table.
   */
  hasPendingOffer(tableId: string): boolean {
    const state = this.activeOffers.get(tableId);
    return state?.status === 'offered' || state?.status === 'accepted';
  }

  /**
   * FIX 96: Chooser decides the number of runs.
   * If runs === 1, this effectively declines RIT.
   */
  chooserDecides(tableId: string, userId: string, runs: 1 | 2 | 3): void {
    const state = this.activeOffers.get(tableId);
    if (!state || state.chooserPlayerId !== userId) return;
    state.chosenRuns = runs;
    if (runs === 1) {
      state.status = 'declined';
      // Phase 1.2 PR-G-real: cancel pending expiry deadline.
      this.scheduler.cancel(tableId, RunItTwiceEngine.OFFER_EVENT_ID);
    }
  }

  private clearOffer(tableId: string): void {
    // Phase 1.2 PR-G-real: cancel any pending expiry deadline for this table.
    if (this.activeOffers.has(tableId)) {
      this.scheduler.cancel(tableId, RunItTwiceEngine.OFFER_EVENT_ID);
    }
    this.activeOffers.delete(tableId);
  }

  dispose(tableId: string): void {
    this.clearOffer(tableId);
    this.tableConfigs.delete(tableId);
  }

  disposeAll(): void {
    for (const [tableId] of this.activeOffers) {
      this.clearOffer(tableId);
    }
    this.tableConfigs.clear();
  }

  private emitEvent(event: RITEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch (err) {
        reportError(err, 'RunItTwiceEngine.Event_handler_error');
      }
    }
  }
}
