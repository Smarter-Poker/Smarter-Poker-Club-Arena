/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  STRADDLE ENGINE — Auto-Straddle and Mississippi Straddle Support
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages straddle logic for cash game tables:
 * - UTG straddle (standard: 2x BB)
 * - Mississippi straddle (any position except blinds)
 * - Configurable cap (2x, 3x, unlimited re-straddles)
 * - Auto-straddle enrollment per player
 * - Bus emissions for UI synchronization
 */

import { masterBus } from '../core/MasterBus';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface StraddleConfig {
  enabled: boolean;
  mississippiEnabled: boolean; // Allow straddle from any position
  maxStraddles: number; // Max consecutive re-straddles (1 = UTG only, 0 = unlimited)
  straddleMultiplier: number; // Usually 2x the previous blind/straddle
}

export interface StraddleState {
  tableId: string;
  enrolledPlayers: Set<string>; // Players with auto-straddle ON
  currentHandStraddles: StraddlePost[]; // Straddles posted this hand
}

export interface StraddlePost {
  playerId: string;
  seatNumber: number;
  amount: number;
  isAutoStraddle: boolean;
}

export interface StraddleResult {
  posted: boolean;
  straddles: StraddlePost[];
  adjustedBigBlind: number; // The effective big blind after straddles
  firstToAct: number; // Seat number of first to act (after last straddle)
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRADDLE ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class StraddleEngineClass {
  private tableConfigs: Map<string, StraddleConfig> = new Map();
  private tableStates: Map<string, StraddleState> = new Map();

  /**
   * Configure straddle for a table
   */
  configure(tableId: string, config: StraddleConfig): void {
    this.tableConfigs.set(tableId, config);
    if (!this.tableStates.has(tableId)) {
      this.tableStates.set(tableId, {
        tableId,
        enrolledPlayers: new Set(),
        currentHandStraddles: [],
      });
    }
  }

  /**
   * Toggle auto-straddle for a player
   */
  toggleAutoStraddle(tableId: string, playerId: string, enabled: boolean): void {
    const state = this.tableStates.get(tableId);
    if (!state) return;

    if (enabled) {
      state.enrolledPlayers.add(playerId);
    } else {
      state.enrolledPlayers.delete(playerId);
    }

    masterBus.emit('STRADDLE_TOGGLED', {
      tableId,
      playerId,
      enabled,
    });
  }

  /**
   * Check if a player has auto-straddle on
   */
  isAutoStraddleOn(tableId: string, playerId: string): boolean {
    return this.tableStates.get(tableId)?.enrolledPlayers.has(playerId) ?? false;
  }

  /**
   * Process straddles at the start of a new hand.
   * Called by HeadlessTableEngine after blinds are posted, before preflop action.
   *
   * @param tableId - The table
   * @param bigBlind - Current big blind amount
   * @param seatOrder - Seats in order starting from UTG (post-BB)
   * @param playerStacks - Map of playerId -> current stack
   * @returns Straddle result with all posted straddles
   */
  processStraddles(
    tableId: string,
    bigBlind: number,
    seatOrder: Array<{ seat: number; playerId: string }>,
    playerStacks: Map<string, number>
  ): StraddleResult {
    const config = this.tableConfigs.get(tableId);
    const state = this.tableStates.get(tableId);

    const result: StraddleResult = {
      posted: false,
      straddles: [],
      adjustedBigBlind: bigBlind,
      firstToAct: seatOrder[0]?.seat ?? 0,
    };

    if (!config?.enabled || !state) return result;

    // Reset current hand straddles
    state.currentHandStraddles = [];

    let currentAmount = bigBlind;
    let straddleCount = 0;
    const maxStraddles = config.maxStraddles === 0 ? Infinity : config.maxStraddles;

    // Iterate through seats starting from UTG
    for (const { seat, playerId } of seatOrder) {
      if (straddleCount >= maxStraddles) break;

      // Check if this player has auto-straddle enabled
      if (!state.enrolledPlayers.has(playerId)) break; // Stop at first non-straddler

      // Mississippi straddle: any position (if enabled), else only UTG
      if (!config.mississippiEnabled && straddleCount > 0) break;

      const straddleAmount = currentAmount * config.straddleMultiplier;
      const stack = playerStacks.get(playerId) ?? 0;

      // Player must have enough chips to straddle
      if (stack < straddleAmount) break;

      const post: StraddlePost = {
        playerId,
        seatNumber: seat,
        amount: straddleAmount,
        isAutoStraddle: true,
      };

      state.currentHandStraddles.push(post);
      result.straddles.push(post);
      result.posted = true;
      result.adjustedBigBlind = straddleAmount;

      currentAmount = straddleAmount;
      straddleCount++;

      // Emit bus event for each straddle posted
      masterBus.emit('STRADDLE_POSTED', {
        tableId,
        playerId,
        seatNumber: seat,
        amount: straddleAmount,
        straddleNumber: straddleCount,
      });
    }

    // First to act is the seat after the last straddler
    if (result.straddles.length > 0) {
      const lastStraddleSeatIdx = seatOrder.findIndex(
        (s) => s.seat === result.straddles[result.straddles.length - 1].seatNumber
      );
      const nextIdx = (lastStraddleSeatIdx + 1) % seatOrder.length;
      result.firstToAct = seatOrder[nextIdx].seat;
    }

    return result;
  }

  /**
   * Manual straddle post (player clicks "Straddle" button)
   */
  postManualStraddle(
    tableId: string,
    playerId: string,
    seatNumber: number,
    bigBlind: number,
    stack: number
  ): StraddlePost | null {
    const config = this.tableConfigs.get(tableId);
    const state = this.tableStates.get(tableId);
    if (!config?.enabled || !state) return null;

    const currentMax =
      state.currentHandStraddles.length > 0
        ? state.currentHandStraddles[state.currentHandStraddles.length - 1].amount
        : bigBlind;

    const straddleAmount = currentMax * config.straddleMultiplier;
    if (stack < straddleAmount) return null;

    const maxStraddles = config.maxStraddles === 0 ? Infinity : config.maxStraddles;
    if (state.currentHandStraddles.length >= maxStraddles) return null;

    const post: StraddlePost = {
      playerId,
      seatNumber,
      amount: straddleAmount,
      isAutoStraddle: false,
    };

    state.currentHandStraddles.push(post);

    masterBus.emit('STRADDLE_POSTED', {
      tableId,
      playerId,
      seatNumber,
      amount: straddleAmount,
      straddleNumber: state.currentHandStraddles.length,
    });

    return post;
  }

  /**
   * Get current straddle state for a table
   */
  getState(tableId: string): StraddleState | null {
    return this.tableStates.get(tableId) ?? null;
  }

  /**
   * Cleanup when table closes
   */
  dispose(tableId: string): void {
    this.tableConfigs.delete(tableId);
    this.tableStates.delete(tableId);
  }
}

export const straddleEngine = new StraddleEngineClass();
export default straddleEngine;
