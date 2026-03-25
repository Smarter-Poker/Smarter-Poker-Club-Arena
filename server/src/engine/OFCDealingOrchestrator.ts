/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  OFC DEALING ORCHESTRATOR — Chinese Poker Dealing Loop
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Drives the Open Face Chinese Pineapple dealing flow:
 * 1. Initial deal: 5 cards to each player (13 for Fantasyland players)
 * 2. Pineapple rounds: 3 cards dealt, player places 2 and discards 1
 * 3. After all rounds: score hands, apply royalties, check for Fantasyland
 * 4. Uses OFCPineappleEngine for game logic
 *
 * Ported from client: src/engine/OFCDealingOrchestrator.ts (305 lines)
 * Server adaptation: No masterBus — uses optional onEvent callback. Class export, not singleton.
 */

import {
  OFCPineappleEngine,
  type OFCGameState,
  type OFCPlayer,
  type OFCCard,
  type OFCRow,
} from './OFCPineappleEngine.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface OFCOrchestratorConfig {
  tableId: string;
  /** Seconds per placement decision (default: 30) */
  placementTimeoutSeconds: number;
  /** Whether Fantasyland is enabled (default: true) */
  fantasylandEnabled: boolean;
  /** Auto-foul on timeout (default: true) */
  autoFoulOnTimeout: boolean;
}

export interface OFCDealingState {
  config: OFCOrchestratorConfig;
  game: OFCGameState | null;
  handNumber: number;
  currentRound: number;
  isActive: boolean;
  fantasylandPlayers: Set<string>;
}

export type OFCEventType =
  | 'OFC_HAND_STARTED'
  | 'OFC_CARDS_DEALT'
  | 'OFC_TURN_CHANGE'
  | 'OFC_FANTASYLAND_ENTERED'
  | 'OFC_SCORING_COMPLETE';

export interface OFCEvent {
  type: OFCEventType;
  tableId: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OFC DEALING ORCHESTRATOR CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class OFCDealingOrchestrator {
  private tables: Map<string, OFCDealingState> = new Map();
  private turnTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private onEvent?: (event: OFCEvent) => void;

  constructor(onEvent?: (event: OFCEvent) => void) {
    this.onEvent = onEvent;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════

  configure(config: OFCOrchestratorConfig): void {
    const existing = this.tables.get(config.tableId);
    if (existing) {
      existing.config = config;
    } else {
      this.tables.set(config.tableId, {
        config,
        game: null,
        handNumber: 0,
        currentRound: 0,
        isActive: false,
        fantasylandPlayers: new Set(),
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DEALING LOOP
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start a new OFC hand using OFCPineappleEngine's createGame().
   */
  startHand(tableId: string, playerIds: string[], playerNames: string[]): void {
    const state = this.tables.get(tableId);
    if (!state || playerIds.length < 2) return;

    state.handNumber++;
    state.isActive = true;
    state.currentRound = 0;

    // Use the OFCPineappleEngine to create the game state
    const game = OFCPineappleEngine.createGame(playerIds, playerNames);

    // Mark Fantasyland players
    for (const player of game.players) {
      if (state.fantasylandPlayers.has(player.id)) {
        player.isFantasyland = true;
      }
    }

    state.game = game;

    this.emitEvent({
      type: 'OFC_HAND_STARTED',
      tableId,
      handNumber: state.handNumber,
      players: playerIds,
    });

    // Deal initial cards using the engine
    state.game = OFCPineappleEngine.dealInitialCards(state.game);

    // Emit dealt events
    for (const player of state.game.players) {
      this.emitEvent({
        type: 'OFC_CARDS_DEALT',
        tableId,
        playerId: player.id,
        cardCount: player.currentCards.length,
        isFantasyland: player.isFantasyland,
      });
    }

    // Start placement timer for first player
    this.startPlacementTimer(tableId);
  }

  /**
   * Start a pineapple round: deal 3 cards to each non-FL player
   */
  startPineappleRound(tableId: string): void {
    const state = this.tables.get(tableId);
    if (!state?.game) return;

    state.currentRound++;

    if (state.currentRound > 4) {
      // All 4 pineapple rounds complete — score
      this.scoreHands(tableId);
      return;
    }

    // Deal pineapple cards using engine
    state.game = OFCPineappleEngine.dealPineappleRound(state.game);

    for (const player of state.game!.players) {
      if (!player.isFantasyland && player.currentCards.length > 0) {
        this.emitEvent({
          type: 'OFC_CARDS_DEALT',
          tableId,
          playerId: player.id,
          cardCount: player.currentCards.length,
          isFantasyland: false,
        });
      }
    }

    state.game!.currentPlayerIndex = 0;
    this.startPlacementTimer(tableId);
  }

  /**
   * Process a player placing cards into their rows.
   */
  processPlacement(
    tableId: string,
    playerId: string,
    placements: Array<{ card: OFCCard; row: OFCRow }>
  ): boolean {
    const state = this.tables.get(tableId);
    if (!state?.game) return false;

    const playerIndex = state.game.players.findIndex((p) => p.id === playerId);
    if (playerIndex < 0) return false;

    // Apply placements using the engine
    for (const { card, row } of placements) {
      const player = state.game.players[playerIndex];
      const cardIdx = player.currentCards.findIndex(
        (c) => c.rank === card.rank && c.suit === card.suit
      );
      if (cardIdx >= 0) {
        state.game = OFCPineappleEngine.placeCard(state.game, playerId, cardIdx, row);
      }
    }

    // Clear timer and advance
    this.clearPlacementTimer(tableId);

    state.game.currentPlayerIndex++;

    if (state.game.currentPlayerIndex >= state.game.players.length) {
      if (state.currentRound === 0) {
        this.startPineappleRound(tableId);
      } else if (state.currentRound >= 4) {
        this.scoreHands(tableId);
      } else {
        this.startPineappleRound(tableId);
      }
    } else {
      this.startPlacementTimer(tableId);
    }

    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCORING
  // ═══════════════════════════════════════════════════════════════════════════

  private scoreHands(tableId: string): void {
    const state = this.tables.get(tableId);
    if (!state?.game) return;

    const scores: Record<string, number> = {};
    const nextFantasyland: Set<string> = new Set();

    // Score using the engine
    state.game = OFCPineappleEngine.scoreGame(state.game);

    for (const player of state.game.players) {
      scores[player.id] = player.score;

      // Check Fantasyland qualification (engine already checks in scoreGame)
      if (state.config.fantasylandEnabled && state.game.fantasylandQueue.includes(player.id)) {
        nextFantasyland.add(player.id);
        this.emitEvent({
          type: 'OFC_FANTASYLAND_ENTERED',
          tableId,
          playerId: player.id,
        });
      }
    }

    state.fantasylandPlayers = nextFantasyland;
    state.isActive = false;
    state.game.status = 'finished';

    this.emitEvent({
      type: 'OFC_SCORING_COMPLETE',
      tableId,
      scores,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIMER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  private startPlacementTimer(tableId: string): void {
    const state = this.tables.get(tableId);
    if (!state?.game) return;

    const player = state.game.players[state.game.currentPlayerIndex];
    if (!player) return;

    this.emitEvent({
      type: 'OFC_TURN_CHANGE',
      tableId,
      playerId: player.id,
    });

    const timer = setTimeout(() => {
      if (state.config.autoFoulOnTimeout) {
        const p = state.game!.players[state.game!.currentPlayerIndex];
        if (p) p.isFouled = true;
      }

      state.game!.currentPlayerIndex++;
      if (state.game!.currentPlayerIndex >= state.game!.players.length) {
        if (state.currentRound >= 4 || state.currentRound === 0) {
          this.scoreHands(tableId);
        } else {
          this.startPineappleRound(tableId);
        }
      } else {
        this.startPlacementTimer(tableId);
      }
    }, state.config.placementTimeoutSeconds * 1000);

    this.turnTimers.set(tableId, timer);
  }

  private clearPlacementTimer(tableId: string): void {
    const timer = this.turnTimers.get(tableId);
    if (timer) {
      clearTimeout(timer);
      this.turnTimers.delete(tableId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STATE QUERIES
  // ═══════════════════════════════════════════════════════════════════════════

  getState(tableId: string): OFCDealingState | null {
    return this.tables.get(tableId) ?? null;
  }

  isActive(tableId: string): boolean {
    return this.tables.get(tableId)?.isActive ?? false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════

  dispose(tableId: string): void {
    this.clearPlacementTimer(tableId);
    this.tables.delete(tableId);
  }

  disposeAll(): void {
    for (const [tableId] of this.tables) {
      this.clearPlacementTimer(tableId);
    }
    this.tables.clear();
  }

  private emitEvent(event: OFCEvent): void {
    if (this.onEvent) {
      try { this.onEvent(event); } catch (err) { console.error('[OFCDealingOrchestrator] Event handler error:', err); }
    }
  }
}
