import { reportError } from '../services/errorReporter.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  STRADDLE ENGINE — UTG Straddle Only (FIX 114)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages straddle logic for cash game tables:
 * - UTG straddle ONLY (standard: 2x BB, single straddle per hand)
 * - Mississippi straddle REMOVED per Dan's directive
 * - Auto-straddle enrollment per player
 * - Optional event callbacks for UI synchronization
 *
 * Ported from client: src/engine/StraddleEngine.ts (247 lines)
 * Server adaptation: No masterBus — uses optional onEvent callback. Class export, not singleton.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** FIX 114: UTG straddle only — Mississippi removed per Dan's directive */
export interface StraddleConfig {
  enabled: boolean;
  /** FIX 114: maxStraddles always 1 (UTG only, no re-straddles) */
  maxStraddles: number;
  straddleMultiplier: number;
  /**
   * A6/A7 2026-07-20: table-level MANDATORY UTG straddle. When true the UTG
   * player auto-posts the straddle every hand regardless of individual opt-in
   * enrollment (the "Auto UTG Straddle" host setting). When false, only players
   * who opted in via toggleAutoStraddle straddle (the "Voluntary Straddle" host
   * setting). Undefined is treated as false (voluntary-only).
   */
  mandatoryUtg?: boolean;
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
   * Round 66: Remove a player's straddle enrollment on leave so the Set
   * doesn't accumulate stale entries — and so the player isn't silently
   * still-enrolled if they rejoin later. Mirrors DisconnectEngine.unregister
   * + TimeBankEngine.removePlayer cleanup pattern.
   */
  removePlayer(tableId: string, playerId: string): void {
    const state = this.tableStates.get(tableId);
    if (!state) return;
    state.enrolledPlayers.delete(playerId);
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

    // FIX 114: UTG only — first eligible seat in seatOrder posts, then we stop.
    // No Mississippi (multi-position) straddles allowed.
    for (const { seat, playerId } of seatOrder) {
      if (straddleCount >= maxStraddles) break;
      // A6/A7: in mandatory-UTG mode the UTG player straddles regardless of
      // opt-in; otherwise only opted-in (enrolled) players straddle.
      if (!config.mandatoryUtg && !state.enrolledPlayers.has(playerId)) break;
      // FIX 114: Only UTG straddle — always break after first straddle
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
        reportError(err, 'StraddleEngine.Event_handler_error');
      }
    }
  }
}
