/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HORSE BRAIN ADAPTER — Bridge between HeadlessTableEngine and Horse Brain
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This adapter provides a unified interface for horse decisions:
 * - Tries HorsePokerBrain (the full 8148-line brain) first
 * - Falls back to HorseLogic (the simpler built-in brain) if Brain isn't loaded
 * - Handles format translation between engine state ↔ brain state
 * - Manages brain lifecycle (loading, warming caches, feeding results)
 *
 * The Brain expects specific state shapes (documented in the spec).
 * This adapter translates HeadlessTableEngine's internal state to match.
 */

import type { SeatPlayer, GameVariant } from '../types/database.types';
import { HorseLogic, type HorseStyle, type HorseDecision, type TablePosition } from './HorseLogic';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// BRAIN INTERFACES (matching HorsePokerBrain.js spec)
// ═══════════════════════════════════════════════════════════════════════════════

interface BrainPlayerState {
  id: string;
  holeCards: Array<{ rank: number; suit: number }>;
  stack: number;
  position: string; // btn|co|hj|mp|ep|sb|bb|utg
  folded: boolean;
  invested: number; // chips already in pot this street
}

interface BrainEngineState {
  tableId: string;
  players: BrainPlayerState[];
  communityCards: Array<{ rank: number; suit: number }>;
  phase: 'preflop' | 'flop' | 'turn' | 'river';
  potTotal: number;
  currentBet: number;
  variant: 'plo4' | 'plo5' | 'plo6' | 'omaha_hilo' | 'holdem';
  // Optional enrichment
  numLimpers?: number;
  numCallers?: number;
  isLimpedPot?: boolean;
  isSBvsBB?: boolean;
  wasPFRaiser?: boolean;
  allInPlayers?: string[];
  sessionMinutes?: number;
  gameType?: 'cash' | 'tournament';
  numPlayers?: number;
}

interface BrainLegalAction {
  type: 'fold' | 'check' | 'call' | 'bet' | 'raise';
  amount?: number;
  minAmount?: number;
  maxAmount?: number;
}

interface BrainDecision {
  action: string;
  delayMs: number;
  amount?: number;
}

interface BrainTableConfig {
  tableId: string;
  bigBlind: number;
  smallBlind: number;
  variant: string;
  gameType: 'cash' | 'tournament';
}

interface HandResultPlayer {
  id: string;
  chipDelta: number;
  showedCards: boolean;
  folded: boolean;
  lastAction: string;
  betAmount: number;
  actionTimeMs: number;
  hadInitiative: boolean;
  actedAfterCheck: boolean;
  invested: number;
}

interface HandResultData {
  tableId: string;
  bigBlind: number;
  street: string;
  potSize: number;
  numPlayers: number;
  players: HandResultPlayer[];
  result: {
    winners: Array<{ playerId: string }>;
    players: Array<{ id: string; showedCards: boolean; chipDelta: number; invested: number }>;
  };
  ritOffered?: boolean;
  actionCount?: number;
  prevBet?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BRAIN MODULE TYPE (dynamically loaded)
// ═══════════════════════════════════════════════════════════════════════════════

interface HorsePokerBrainModule {
  isHorse: (playerId: string) => Promise<boolean>;
  loadHorseIds: () => Promise<Set<string>>;
  getDecision: (
    horseId: string,
    state: BrainEngineState,
    legalActions: BrainLegalAction[],
    config: BrainTableConfig
  ) => Promise<BrainDecision>;
  processHandResult: (handData: HandResultData, bb: number) => Promise<void>;
  evaluateSessions: (gameController: unknown, tableManager: unknown) => Promise<void>;
  recordSitDown: (tableId: string, horseId: string, buyIn: number) => void;
  recordRebuy: (tableId: string, horseId: string, amount: number) => void;
  clearTableSessions: (tableId: string) => void;
  canSitAtTable: (horseId: string) => Promise<boolean>;
  canRebuy: (
    tableId: string,
    horseId: string,
    minBuyIn: number,
    clubId: string
  ) => Promise<boolean>;
  warmGTOCache: () => Promise<void>;
  getChatMessages: () => Array<{ horseId: string; message: string }>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REBUY STRATEGY TYPE
// ═══════════════════════════════════════════════════════════════════════════════

export type RebuyStrategy = 'always' | 'below_50bb' | 'below_100bb' | 'never';

// ═══════════════════════════════════════════════════════════════════════════════
// ADAPTER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class HorseBrainAdapterClass {
  private brain: HorsePokerBrainModule | null = null;
  private brainLoadAttempted = false;
  private brainAvailable = false;
  private horseIds: Set<string> = new Set();
  private rebuyStrategies: Map<string, RebuyStrategy> = new Map();

  // ═══════════════════════════════════════════════════════════════════════════
  // REBUY STRATEGY
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Configurable rebuy strategy type.
   * - always: rebuy whenever busted
   * - below_50bb: rebuy if stack < 50 big blinds
   * - below_100bb: rebuy if stack < 100 big blinds
   * - never: never rebuy
   */
  setRebuyStrategy(horseId: string, strategy: RebuyStrategy): void {
    this.rebuyStrategies.set(horseId, strategy);
  }

  getRebuyStrategy(horseId: string): RebuyStrategy {
    return this.rebuyStrategies.get(horseId) || 'below_50bb';
  }

  /**
   * Determine if a horse should rebuy based on its configured strategy.
   *
   * @param horseId - The horse's user ID
   * @param currentStack - Horse's current stack
   * @param bigBlind - Table's big blind
   * @returns true if the horse should rebuy
   */
  shouldRebuy(horseId: string, currentStack: number, bigBlind: number): boolean {
    const strategy = this.getRebuyStrategy(horseId);
    switch (strategy) {
      case 'always':
        return currentStack <= 0;
      case 'below_50bb':
        return currentStack < bigBlind * 50;
      case 'below_100bb':
        return currentStack < bigBlind * 100;
      case 'never':
        return false;
      default:
        return currentStack < bigBlind * 50;
    }
  }

  /**
   * Initialize the adapter — try to load HorsePokerBrain.js
   * Falls back to HorseLogic if brain isn't available
   */
  async initialize(): Promise<void> {
    if (this.brainLoadAttempted) return;
    this.brainLoadAttempted = true;

    try {
      // Dynamic import of the brain module
      const brainModule = await import('../lib/poker-engine/HorsePokerBrain.js');
      const loadedBrain = brainModule.default || brainModule;

      // Check if this is the stub or the real brain
      if (loadedBrain.STUB) {
        this.brainAvailable = false;
        return;
      }

      this.brain = loadedBrain as unknown as HorsePokerBrainModule;

      try {
        // Warm GTO cache on startup — CRITICAL
        await this.brain!.warmGTOCache();

        // Load horse IDs
        this.horseIds = await this.brain!.loadHorseIds();

        this.brainAvailable = true;
      } catch (initErr) {
        reportError(initErr, 'HorseBrainAdapter.Brain_initialization_failed_GTO_warmup_h');
        this.brainAvailable = false;
        this.brain = null;
        // Fall through to HorseLogic fallback
      }
    } catch (err: unknown) {
      this.brainAvailable = false;
    }
  }

  /**
   * Check if the full brain is loaded and available
   */
  isBrainAvailable(): boolean {
    return this.brainAvailable && this.brain !== null;
  }

  /**
   * Check if a player is a horse
   */
  async isHorse(playerId: string): Promise<boolean> {
    if (this.brain) {
      return this.brain.isHorse(playerId);
    }
    return this.horseIds.has(playerId);
  }

  /**
   * Get a decision for a horse player
   * Tries HorsePokerBrain first, falls back to HorseLogic
   */
  async getDecision(
    horseId: string,
    enginePlayer: SeatPlayer,
    gameState: {
      players: SeatPlayer[];
      communityCards: unknown[];
      pot: number;
      currentBet: number;
      minRaise: number;
      stage: string;
      gameVariant: string;
      bigBlind: number;
    },
    tableId: string,
    horseStyle: HorseStyle,
    gameType: 'cash' | 'tournament' = 'cash'
  ): Promise<HorseDecision> {
    // ── Try HorsePokerBrain first ──
    if (this.brain) {
      try {
        const brainState = this.translateToBrainState(tableId, enginePlayer, gameState, gameType);
        const legalActions = this.buildLegalActions(enginePlayer, gameState);
        const config: BrainTableConfig = {
          tableId,
          bigBlind: gameState.bigBlind,
          smallBlind: gameState.bigBlind / 2,
          variant: this.mapVariant(gameState.gameVariant),
          gameType,
        };

        const brainDecision = await this.brain.getDecision(
          horseId,
          brainState,
          legalActions,
          config
        );

        return {
          action: this.mapBrainAction(brainDecision.action) as any,
          amount: brainDecision.amount,
          thinkTime: brainDecision.delayMs || 500,
        };
      } catch (err: unknown) {
        reportError(err, 'HorseBrainAdapter.Brain_decision_failed_for_horseId_fallin');
      }
    }

    // ── Fallback: use HorseLogic with position awareness ──
    // Calculate position from player seat and game state
    const activePlayers = gameState.players.filter(
      (p: SeatPlayer) => !p.is_folded && !p.is_sitting_out
    );
    const position = HorseLogic.getPosition(
      enginePlayer.seat,
      0, // Dealer seat — would need to be passed in for full accuracy
      activePlayers.length
    );
    return HorseLogic.decide(enginePlayer, gameState as any, horseStyle, position);
  }

  /**
   * Feed hand result data to brain's 32 anti-exploit modules
   */
  async processHandResult(
    tableId: string,
    bigBlind: number,
    stage: string,
    potSize: number,
    players: Array<{
      user_id: string;
      chipDelta: number;
      showedCards: boolean;
      folded: boolean;
      invested: number;
    }>,
    winners: string[]
  ): Promise<void> {
    if (!this.brain) return;

    try {
      const handData: HandResultData = {
        tableId,
        bigBlind,
        street: stage,
        potSize,
        numPlayers: players.length,
        players: players.map((p) => ({
          id: p.user_id,
          chipDelta: p.chipDelta,
          showedCards: p.showedCards,
          folded: p.folded,
          lastAction: 'unknown',
          betAmount: p.invested,
          actionTimeMs: 1000,
          hadInitiative: false,
          actedAfterCheck: false,
          invested: p.invested,
        })),
        result: {
          winners: winners.map((id) => ({ playerId: id })),
          players: players.map((p) => ({
            id: p.user_id,
            showedCards: p.showedCards,
            chipDelta: p.chipDelta,
            invested: p.invested,
          })),
        },
      };

      await this.brain.processHandResult(handData, bigBlind);
    } catch (err: unknown) {
      // Non-blocking — never fail the hand pipeline
      reportError(err, 'HorseBrainAdapter.processHandResult_error');
    }
  }

  /**
   * Evaluate sessions between hands (cashout/tilt/rebuy decisions)
   */
  async evaluateSessions(gameController: unknown, tableManager: unknown): Promise<void> {
    if (!this.brain) return;
    try {
      await this.brain.evaluateSessions(gameController, tableManager);
    } catch (err: unknown) {
      reportError(err, 'HorseBrainAdapter.evaluateSessions_error');
    }
  }

  /**
   * Record when a horse sits down at a table
   */
  recordSitDown(tableId: string, horseId: string, buyIn: number): void {
    if (this.brain) {
      this.brain.recordSitDown(tableId, horseId, buyIn);
    }
  }

  /**
   * Record when a horse rebuys
   */
  recordRebuy(tableId: string, horseId: string, amount: number): void {
    if (this.brain) {
      this.brain.recordRebuy(tableId, horseId, amount);
    }
  }

  /**
   * Clean up when a table closes
   */
  clearTableSessions(tableId: string): void {
    if (this.brain) {
      this.brain.clearTableSessions(tableId);
    }
  }

  /**
   * Check if a horse can sit at another table (multi-table limit)
   */
  async canSitAtTable(horseId: string): Promise<boolean> {
    if (this.brain) {
      return this.brain.canSitAtTable(horseId);
    }
    return true; // No limit without brain
  }

  /**
   * Check if a horse can rebuy (bankroll + stop-loss)
   */
  async canRebuy(
    tableId: string,
    horseId: string,
    minBuyIn: number,
    clubId: string
  ): Promise<boolean> {
    if (this.brain) {
      return this.brain.canRebuy(tableId, horseId, minBuyIn, clubId);
    }
    // Fallback: use configurable rebuy strategy
    // Note: without full stack information here, we allow rebuy if strategy isn't 'never'
    const strategy = this.getRebuyStrategy(horseId);
    return strategy !== 'never';
  }

  /**
   * Get pending chat messages from horses
   */
  getChatMessages(): Array<{ horseId: string; message: string }> {
    if (this.brain) {
      return this.brain.getChatMessages();
    }
    return [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE: State Translation
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Translate HeadlessTableEngine state → HorsePokerBrain engineState
   */
  private translateToBrainState(
    tableId: string,
    enginePlayer: SeatPlayer,

    gameState: any, // Complex engine state object — typing would cascade across adapter boundary
    gameType: 'cash' | 'tournament'
  ): BrainEngineState {
    const positionMap: Record<number, string> = {};
    const playerCount = gameState.players.filter((p: SeatPlayer) => !p.is_folded).length;

    // Map seat positions based on player count and dealer position
    const positions = this.getPositionLabels(playerCount);
    const activePlayers = gameState.players.filter((p: SeatPlayer) => !p.is_folded);
    activePlayers.forEach((p: SeatPlayer, i: number) => {
      positionMap[p.seat] = positions[i % positions.length];
    });

    return {
      tableId,
      players: gameState.players.map((p: SeatPlayer) => ({
        id: p.user_id,
        holeCards: (p.cards || []).map((c: { rank: string; suit: string }) => ({
          rank: typeof c.rank === 'number' ? c.rank : this.parseRank(c.rank),
          suit: typeof c.suit === 'number' ? c.suit : this.parseSuit(c.suit),
        })),
        stack: p.stack,
        position: positionMap[p.seat] || 'mp',
        folded: p.is_folded || false,
        invested: p.bet || 0,
      })),
      communityCards: (gameState.communityCards || []).map((c: { rank: string; suit: string }) => ({
        rank: typeof c.rank === 'number' ? c.rank : this.parseRank(c.rank),
        suit: typeof c.suit === 'number' ? c.suit : this.parseSuit(c.suit),
      })),
      phase: this.mapStage(gameState.stage),
      potTotal: gameState.pot,
      currentBet: gameState.currentBet,
      variant: this.mapVariant(gameState.gameVariant),
      gameType,
      numPlayers: playerCount,
    };
  }

  /**
   * Build legal actions array from current game state
   */

  private buildLegalActions(enginePlayer: SeatPlayer, gameState: any): BrainLegalAction[] {
    const toCall = Math.max(0, gameState.currentBet - (enginePlayer.bet || 0));
    const actions: BrainLegalAction[] = [];

    if (toCall > 0) {
      // Facing a bet
      actions.push({ type: 'fold' });
      actions.push({ type: 'call', amount: Math.min(toCall, enginePlayer.stack) });
      if (enginePlayer.stack > toCall) {
        actions.push({
          type: 'raise',
          minAmount: gameState.currentBet + gameState.minRaise,
          maxAmount: enginePlayer.stack + (enginePlayer.bet || 0),
        });
      }
    } else {
      // No bet facing
      actions.push({ type: 'check' });
      actions.push({
        type: 'bet',
        minAmount: gameState.minRaise || gameState.bigBlind,
        maxAmount: enginePlayer.stack,
      });
    }

    return actions;
  }

  private getPositionLabels(playerCount: number): string[] {
    switch (playerCount) {
      case 2:
        return ['sb', 'bb'];
      case 3:
        return ['btn', 'sb', 'bb'];
      case 4:
        return ['btn', 'co', 'sb', 'bb'];
      case 5:
        return ['btn', 'co', 'hj', 'sb', 'bb'];
      case 6:
        return ['btn', 'co', 'hj', 'mp', 'sb', 'bb'];
      case 7:
        return ['btn', 'co', 'hj', 'mp', 'ep', 'sb', 'bb'];
      case 8:
        return ['btn', 'co', 'hj', 'mp', 'ep', 'utg', 'sb', 'bb'];
      case 9:
        return ['btn', 'co', 'hj', 'mp', 'ep', 'utg', 'utg', 'sb', 'bb'];
      default:
        return ['btn', 'co', 'hj', 'mp', 'ep', 'utg', 'sb', 'bb'];
    }
  }

  private mapStage(stage: string): 'preflop' | 'flop' | 'turn' | 'river' {
    const map: Record<string, 'preflop' | 'flop' | 'turn' | 'river'> = {
      preflop: 'preflop',
      flop: 'flop',
      turn: 'turn',
      river: 'river',
      pre_flop: 'preflop',
      PREFLOP: 'preflop',
      FLOP: 'flop',
      TURN: 'turn',
      RIVER: 'river',
    };
    return map[stage] || 'preflop';
  }

  private mapVariant(variant: string): 'plo4' | 'plo5' | 'plo6' | 'omaha_hilo' | 'holdem' {
    const map: Record<string, 'plo4' | 'plo5' | 'plo6' | 'omaha_hilo' | 'holdem'> = {
      nlh: 'holdem',
      holdem: 'holdem',
      NLH: 'holdem',
      plo4: 'plo4',
      plo: 'plo4',
      PLO4: 'plo4',
      omaha4: 'plo4',
      plo5: 'plo5',
      PLO5: 'plo5',
      omaha5: 'plo5',
      plo6: 'plo6',
      PLO6: 'plo6',
      omaha6: 'plo6',
      omaha_hilo: 'omaha_hilo',
      plo8: 'omaha_hilo',
    };
    return map[variant] || 'holdem';
  }

  private mapBrainAction(action: string): string {
    // Brain returns standard actions — normalize to engine format
    const map: Record<string, string> = {
      fold: 'fold',
      check: 'check',
      call: 'call',
      bet: 'bet',
      raise: 'raise',
      allin: 'allin',
      all_in: 'allin',
      'all-in': 'allin',
    };
    return map[action?.toLowerCase()] || 'fold';
  }

  private parseRank(rank: string | number): number {
    if (typeof rank === 'number') return rank;
    const map: Record<string, number> = {
      '2': 2,
      '3': 3,
      '4': 4,
      '5': 5,
      '6': 6,
      '7': 7,
      '8': 8,
      '9': 9,
      '10': 10,
      T: 10,
      J: 11,
      Q: 12,
      K: 13,
      A: 14,
    };
    return map[rank] || 0;
  }

  private parseSuit(suit: string | number): number {
    if (typeof suit === 'number') return suit;
    const map: Record<string, number> = {
      spades: 0,
      s: 0,
      '♠': 0,
      hearts: 1,
      h: 1,
      '♥': 1,
      diamonds: 2,
      d: 2,
      '♦': 2,
      clubs: 3,
      c: 3,
      '♣': 3,
    };
    return map[suit?.toLowerCase()] || 0;
  }
}

// Singleton export
export const HorseBrainAdapter = new HorseBrainAdapterClass();
