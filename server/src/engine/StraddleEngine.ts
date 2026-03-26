/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  STRADDLE ENGINE — UTG Straddle Support (2x BB)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages UTG straddle logic for cash game tables:
 * - UTG straddle only (standard: 2x BB, posted by first player after BB)
 * - Auto-straddle enrollment per player
 * - Optional event callbacks for UI synchronization
 *
 * FIX 114: Mississippi straddle REMOVED per Dan's directive — UTG only.
 * Only the player in UTG position can straddle. One straddle per hand max.
 *
 * Ported from client: src/engine/StraddleEngine.ts
 * Server adaptation: No masterBus — uses optional onEvent callback. Class export, not singleton.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface StraddleConfig {
  enabled: boolean;
  // FIX 114: mississippiEnabled REMOVED — UTG straddle only
  maxStraddles: number; // Always 1 for UTG-only
  straddleMultiplier: number; // Always 2 (2x BB)
}

export interface StraddleState {
  tableId: string;
  enrolledPlayers: Set<string>;
  currentHandStraddles: StraddlePost[];
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
  adjustedBigBlind: number;
  firstToAct: number;
}

export type StraddleEventType = 'STRADDLE_TOGGLED' | 'STRADDLE_POSTED';

export interface StraddleEvent {
  type: StraddleEventType;
  tableId: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRADDLE ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class StraddleEngine {
  private tableConfigs: Map<string, StraddleConfig> = new Map();
  private tableStates: Map<string, StraddleState> = new Map();
  private onEvent?: (event: StraddleEvent) => void;

  constructor(onEvent?: (event: StraddleEvent) => void) {
    this.onEvent = onEvent;
  }

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

  toggleAutoStraddle(tableId: string, playerId: string, enabled: boolean): void {
    const state = this.tableStates.get(tableId);
    if (!state) return;

    if (enabled) {
      state.enrolledPlayers.add(playerId);
    } else {
      state.enrolledPlayers.delete(playerId);
    }

    this.emitEvent({ type: 'STRADDLE_TOGGLED', tableId, playerId, enabled });
  }

  isAutoStraddleOn(tableId: string, playerId: string): boolean {
    return this.tableStates.get(tableId)?.enrolledPlayers.has(playerId) ?? false;
  }

  /**
   * Process straddles at the start of a new hand.
   * Called by ServerTableEngine after blinds are posted, before preflop action.
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

    state.currentHandStraddles = [];

    let currentAmount = bigBlind;
    let straddleCount = 0;
    const maxStraddles = config.maxStraddles === 0 ? Infinity : config.maxStraddles;

    // FIX 114: UTG-only straddle. Only the first player in seatOrder (UTG) can straddle.
    // One straddle max. If UTG is not enrolled or can't afford it, no straddle.
    for (const { seat, playerId } of seatOrder) {
      if (straddleCount >= maxStraddles) break;

      // UTG only — if this player isn't enrolled, stop (no skipping to next seat)
      if (!state.enrolledPlayers.has(playerId)) break;

      // UTG only — after one straddle, stop
      if (straddleCount > 0) break;

      const straddleAmount = currentAmount * config.straddleMultiplier;
      const stack = playerStacks.get(playerId) ?? 0;
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

      this.emitEvent({
        type: 'STRADDLE_POSTED',
        tableId,
        playerId,
        seatNumber: seat,
        amount: straddleAmount,
        straddleNumber: straddleCount,
      });
    }

    if (result.straddles.length > 0) {
      const lastStraddleSeatIdx = seatOrder.findIndex(
        (s) => s.seat === result.straddles[result.straddles.length - 1].seatNumber
      );
      const nextIdx = (lastStraddleSeatIdx + 1) % seatOrder.length;
      result.firstToAct = seatOrder[nextIdx].seat;
    }

    return result;
  }

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

    this.emitEvent({
      type: 'STRADDLE_POSTED',
      tableId,
      playerId,
      seatNumber,
      amount: straddleAmount,
      straddleNumber: state.currentHandStraddles.length,
    });

    return post;
  }

  getState(tableId: string): StraddleState | null {
    return this.tableStates.get(tableId) ?? null;
  }

  dispose(tableId: string): void {
    this.tableConfigs.delete(tableId);
    this.tableStates.delete(tableId);
  }

  disposeAll(): void {
    this.tableConfigs.clear();
    this.tableStates.clear();
  }

  private emitEvent(event: StraddleEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch (err) {
        console.error('[StraddleEngine] Event handler error:', err);
      }
    }
  }
}
