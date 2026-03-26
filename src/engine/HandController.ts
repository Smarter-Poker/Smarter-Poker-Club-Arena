/**
 * ♠ CLUB ARENA — Hand Controller
 * ═══════════════════════════════════════════════════════════════════════════════
 * Manages the flow of a single poker hand
 * Dealing, betting rounds, showdown
 */

import {
  Deck,
  evaluateHand,
  evaluateOmahaHand,
  calculatePots,
  calculateBettingState,
  validateAction,
  calculateRake,
  determineWinners,
  type EvaluatedHand,
  type Pot,
  type Winner,
  type RakeConfig,
} from './PokerEngine';
import type { Card, HandStage, SeatPlayer, ActionType, GameVariant } from '../types/database.types';
import { engineTelemetry } from './EngineTelemetry';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface HandConfig {
  tableId: string;
  handNumber: number;
  gameVariant: GameVariant;
  smallBlind: number;
  bigBlind: number;
  ante?: number;
  bigBlindAnte?: boolean; // If true, BB posts ante for entire table
  rakeConfig: RakeConfig;
  bombPot?: {
    anteMultiplier: number; // Each player antes this many BBs
  };
  straddles?: { seat: number; amount: number }[]; // Injected by StraddleEngine
  ritEnabled?: boolean; // If enabled, intercepts all-in runouts
}

export interface GameState {
  stage: HandStage;
  deck: Deck;
  communityCards: Card[];
  pot: number;
  currentBet: number;
  lastRaise: number;
  minRaise: number;
  dealerSeat: number;
  currentPlayerSeat: number;
  players: SeatPlayer[];
  pots: Pot[];
  actionHistory: ActionRecord[];
  sawFlop: boolean;
}

export interface ActionRecord {
  seat: number;
  userId: string;
  action: ActionType;
  amount: number;
  timestamp: number;
  stage: HandStage;
}

export type HandEvent =
  | { type: 'HAND_START'; handNumber: number; players: SeatPlayer[] }
  | { type: 'CARDS_DEALT'; seat: number; cards: Card[] }
  | { type: 'COMMUNITY_CARDS'; stage: HandStage; cards: Card[] }
  | { type: 'PLAYER_ACTION'; seat: number; action: ActionType; amount: number }
  | { type: 'POT_UPDATE'; pot: number; pots: Pot[] }
  | { type: 'TURN_CHANGE'; seat: number; availableActions: ActionType[] }
  | {
      type: 'ALL_IN_RUNOUT_PENDING';
      remainingDeck: Card[];
      existingBoard: Card[];
      pot: number;
      activePlayers: SeatPlayer[];
    }
  | { type: 'SHOWDOWN'; results: ShowdownResult[] }
  | { type: 'WINNERS'; winners: Winner[] }
  | { type: 'HAND_COMPLETE'; handNumber: number; rake: number; pot: number; sawFlop: boolean };

export interface ShowdownResult {
  seat: number;
  userId: string;
  cards: Card[];
  hand: EvaluatedHand;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HAND CONTROLLER
// ═══════════════════════════════════════════════════════════════════════════════

export class HandController {
  private config: HandConfig;
  private state: GameState;
  private eventHandlers: ((event: HandEvent) => void)[] = [];

  constructor(config: HandConfig, players: SeatPlayer[], dealerSeat: number) {
    this.config = config;

    const deck = new Deck();

    // Short Deck variant
    if (config.gameVariant === 'short_deck') {
      deck.removeCardsBelow('6');
    }

    this.state = {
      stage: 'preflop',
      deck,
      communityCards: [],
      pot: 0,
      currentBet: 0,
      lastRaise: config.bigBlind,
      minRaise: config.bigBlind,
      dealerSeat,
      currentPlayerSeat: -1,
      players: this.initializePlayers(players),
      pots: [],
      actionHistory: [],
      sawFlop: false,
    };
  }

  // Telemetry: track hand start time
  private handStartedAt: number = Date.now();

  // To prevent double RIT triggering
  private isWaitingForRIT = false;

  // ─────────────────────────────────────────────────────────────────────────────
  // Event System
  // ─────────────────────────────────────────────────────────────────────────────

  onEvent(handler: (event: HandEvent) => void): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }

  private emit(event: HandEvent): void {
    for (const handler of this.eventHandlers) {
      handler(event);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────────

  private initializePlayers(players: SeatPlayer[]): SeatPlayer[] {
    return players.map((p) => ({
      ...p,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Start Hand
  // ─────────────────────────────────────────────────────────────────────────────

  start(): void {
    this.emit({
      type: 'HAND_START',
      handNumber: this.config.handNumber,
      players: this.state.players,
    });

    // Post blinds or bomb pot antes
    if (this.config.bombPot) {
      this.postBombPotAntes();
    } else {
      this.postBlinds();
    }

    // Deal hole cards
    this.dealHoleCards();

    // Bomb pot: skip preflop entirely — deal flop and start betting there
    if (this.config.bombPot) {
      this.state.stage = 'flop';
      this.state.sawFlop = true;
      const flop = this.state.deck.deal(3);
      this.state.communityCards.push(...flop);
      this.emit({ type: 'COMMUNITY_CARDS', stage: 'flop', cards: flop });

      // Check if we can continue betting (all but one may be all-in from antes)
      const activePlayers = this.getActivePlayers().filter((p) => !p.is_all_in);
      if (activePlayers.length < 2) {
        this.runOutCommunityCards();
        return;
      }

      this.state.currentPlayerSeat = this.getFirstPostflopPlayer();
      this.emitTurnChange();
      return;
    }

    // Set first player to act
    this.setNextPlayer();

    this.emitTurnChange();
  }

  private postBlinds(): void {
    const { smallBlind, bigBlind } = this.config;
    const activePlayers = this.getActivePlayers();

    if (activePlayers.length < 2) return;

    // Heads-up: dealer IS the small blind
    const isHeadsUp = activePlayers.length === 2;
    const sbSeat = isHeadsUp
      ? this.state.dealerSeat
      : this.getNextActiveSeat(this.state.dealerSeat);
    const bbSeat = this.getNextActiveSeat(sbSeat);

    // Post small blind
    const sbPlayer = this.state.players.find((p) => p.seat === sbSeat);
    if (sbPlayer) {
      const sbAmount = Math.min(smallBlind, sbPlayer.stack);
      sbPlayer.bet = sbAmount;
      sbPlayer.totalInvested += sbAmount;
      sbPlayer.stack -= sbAmount;
      this.state.pot += sbAmount;
    }

    // Post big blind
    const bbPlayer = this.state.players.find((p) => p.seat === bbSeat);
    if (bbPlayer) {
      const bbAmount = Math.min(bigBlind, bbPlayer.stack);
      bbPlayer.bet = bbAmount;
      bbPlayer.totalInvested += bbAmount;
      bbPlayer.stack -= bbAmount;
      this.state.pot += bbAmount;
      this.state.currentBet = bbAmount;
    }

    // Post antes if configured
    if (this.config.ante) {
      if (this.config.bigBlindAnte) {
        // Big Blind Ante (BBA): BB posts ante for all active players
        const activeCount = this.state.players.filter((p) => !p.is_sitting_out).length;
        const totalAnte = this.config.ante * activeCount;
        if (bbPlayer) {
          const bbaAmount = Math.min(totalAnte, bbPlayer.stack);
          bbPlayer.totalInvested += bbaAmount;
          bbPlayer.stack -= bbaAmount;
          this.state.pot += bbaAmount;
        }
      } else {
        // Traditional ante: each player posts individually
        for (const player of this.state.players.filter((p) => !p.is_sitting_out)) {
          const anteAmount = Math.min(this.config.ante, player.stack);
          player.totalInvested += anteAmount;
          player.stack -= anteAmount;
          this.state.pot += anteAmount;
        }
      }
    }

    // Post straddles if configured
    if (this.config.straddles && this.config.straddles.length > 0) {
      for (const straddle of this.config.straddles) {
        const player = this.state.players.find((p) => p.seat === straddle.seat);
        if (player && player.stack > 0) {
          const actualAmount = Math.min(straddle.amount, player.stack);
          // Set their bet and adjust stack
          player.bet = actualAmount;
          player.totalInvested += actualAmount;
          player.stack -= actualAmount;
          this.state.pot += actualAmount;
          // Update game constraints
          if (actualAmount > this.state.currentBet) {
            this.state.lastRaise = actualAmount - this.state.currentBet;
            this.state.currentBet = actualAmount;
          }
        }
      }
    }

    this.emit({ type: 'POT_UPDATE', pot: this.state.pot, pots: this.state.pots });
  }

  private postBombPotAntes(): void {
    const { bigBlind, bombPot } = this.config;
    if (!bombPot) return;

    const anteAmount = bigBlind * bombPot.anteMultiplier;

    for (const player of this.state.players.filter((p) => !p.is_sitting_out)) {
      const actualAnte = Math.min(anteAmount, player.stack);
      player.totalInvested += actualAnte;
      player.stack -= actualAnte;
      this.state.pot += actualAnte;
    }

    this.state.currentBet = 0;
    this.emit({ type: 'POT_UPDATE', pot: this.state.pot, pots: this.state.pots });
  }

  private dealHoleCards(): void {
    const cardsPerPlayer = this.getCardsPerPlayer();

    for (const player of this.state.players.filter((p) => !p.is_sitting_out)) {
      player.cards = this.state.deck.deal(cardsPerPlayer);
      this.emit({ type: 'CARDS_DEALT', seat: player.seat, cards: player.cards });
    }
  }

  private getCardsPerPlayer(): number {
    switch (this.config.gameVariant) {
      case 'plo4':
        return 4;
      case 'plo5':
        return 5;
      case 'plo6':
        return 6;
      case 'plo8':
        return 4; // Omaha Hi/Lo
      case 'pineapple':
        return 3;
      case 'ofc':
      case 'ofc_pineapple':
        return 5;
      default:
        return 2; // NLH, Short Deck
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Player Actions
  // ─────────────────────────────────────────────────────────────────────────────

  performAction(seat: number, action: ActionType, amount?: number): boolean {
    const player = this.state.players.find((p) => p.seat === seat);
    if (!player || seat !== this.state.currentPlayerSeat) {
      return false;
    }

    // Validate action
    const bettingState = calculateBettingState(
      this.state.pot,
      this.state.currentBet,
      player.bet,
      this.config.bigBlind,
      this.state.lastRaise
    );

    const validation = validateAction(action, amount, player.stack, bettingState);
    if (!validation.valid) {
      console.debug(`[HC] Action rejected (seat ${seat}): ${validation.error}`);
      return false;
    }

    // Execute action
    let actualAmount = 0;

    switch (action) {
      case 'fold':
        player.is_folded = true;
        break;

      case 'check':
        break;

      case 'call':
        actualAmount = Math.min(bettingState.toCall, player.stack);
        player.bet += actualAmount;
        player.totalInvested += actualAmount;
        player.stack -= actualAmount;
        this.state.pot += actualAmount;
        if (player.stack === 0) player.is_all_in = true;
        break;

      case 'bet':
      case 'raise': {
        actualAmount = amount!;
        const raiseSize = actualAmount - player.bet;
        if (raiseSize > this.state.lastRaise) {
          this.state.lastRaise = raiseSize;
        }
        let chipsAdded = actualAmount - player.bet;
        // ENG-01 FIX: Clamp to stack to prevent negative stack
        if (chipsAdded > player.stack) {
          chipsAdded = player.stack;
          actualAmount = player.bet + chipsAdded;
        }
        player.totalInvested += chipsAdded;
        player.stack -= chipsAdded;
        this.state.pot += chipsAdded;
        player.bet = actualAmount;
        this.state.currentBet = actualAmount;
        if (player.stack === 0) player.is_all_in = true;
        break;
      }

      case 'all_in': {
        actualAmount = player.stack + player.bet;
        player.totalInvested += player.stack;
        this.state.pot += player.stack;
        player.bet += player.stack;
        player.stack = 0;
        player.is_all_in = true;
        if (player.bet > this.state.currentBet) {
          const raiseSize = player.bet - this.state.currentBet;
          if (raiseSize >= this.state.lastRaise) {
            this.state.lastRaise = raiseSize;
          }
          this.state.currentBet = player.bet;
        }
        break;
      }
    }

    // Record action
    this.state.actionHistory.push({
      seat,
      userId: player.user_id,
      action,
      amount: actualAmount,
      timestamp: Date.now(),
      stage: this.state.stage,
    });

    this.emit({
      type: 'PLAYER_ACTION',
      seat,
      action,
      amount: actualAmount,
    });

    this.emit({
      type: 'POT_UPDATE',
      pot: this.state.pot,
      pots: calculatePots(this.state.players),
    });

    // Advance game
    this.advanceGame();

    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Game Flow
  // ─────────────────────────────────────────────────────────────────────────────

  private advanceGame(): void {
    const activePlayers = this.getActivePlayers();

    // Check if hand is over
    if (activePlayers.length === 1) {
      // Everyone else folded
      this.completeHand();
      return;
    }

    // Check if betting round is complete
    if (this.isBettingRoundComplete()) {
      this.advanceStage();
    } else {
      this.setNextPlayer();
      this.emitTurnChange();
    }
  }

  private isBettingRoundComplete(): boolean {
    const activePlayers = this.getActivePlayers();
    const playersToAct = activePlayers.filter((p) => !p.is_all_in);

    // If everyone is all-in (or folded), betting is complete
    if (playersToAct.length === 0) return true;
    // If only one player left who can act and bets are equalized, betting is complete
    if (playersToAct.length === 1) {
      // They still need to have acted this round (or their bet equals current bet)
      const stageActions = this.state.actionHistory.filter((a) => a.stage === this.state.stage);
      const hasActed = stageActions.some((a) => a.seat === playersToAct[0].seat);
      // Must have acted AND bet exactly matches currentBet (=== not >= to prevent unequalized bets)
      if (hasActed && playersToAct[0].bet === this.state.currentBet) return true;
      if (!hasActed) return false;
    }

    // Get actions for this betting round
    const stageActions = this.state.actionHistory.filter((a) => a.stage === this.state.stage);

    // Find the last aggressive action (bet/raise that INCREASED the currentBet)
    let lastAggressorSeat = -1;
    let runningCurrentBet = 0;
    for (const action of stageActions) {
      if (action.action === 'bet' || action.action === 'raise') {
        lastAggressorSeat = action.seat;
        runningCurrentBet = action.amount;
      } else if (action.action === 'all_in') {
        // Only treat all-in as aggression if it RAISED the current bet
        if (action.amount > runningCurrentBet) {
          lastAggressorSeat = action.seat;
          runningCurrentBet = action.amount;
        }
      }
    }

    // Every non-all-in active player must have acted AFTER the last aggressor
    // (or there was no aggression, in which case everyone just needs to have acted once)
    for (const player of playersToAct) {
      const playerActions = stageActions.filter((a) => a.seat === player.seat);

      if (playerActions.length === 0) {
        return false; // This player hasn't acted at all
      }

      // If there was a raise, check this player acted AFTER it
      if (lastAggressorSeat !== -1 && lastAggressorSeat !== player.seat) {
        // Find last aggressor action index (manual findLastIndex for compatibility)
        let lastAggressorActionIdx = -1;
        for (let i = stageActions.length - 1; i >= 0; i--) {
          const a = stageActions[i];
          if (
            a.seat === lastAggressorSeat &&
            (a.action === 'bet' || a.action === 'raise' || a.action === 'all_in')
          ) {
            lastAggressorActionIdx = i;
            break;
          }
        }
        let playerLastActionIdx = -1;
        for (let i = stageActions.length - 1; i >= 0; i--) {
          if (stageActions[i].seat === player.seat) {
            playerLastActionIdx = i;
            break;
          }
        }

        if (playerLastActionIdx < lastAggressorActionIdx) {
          return false; // Player needs to react to the raise
        }
      }
    }

    // All bets must be equalized (except all-ins)
    const targetBet = this.state.currentBet;
    return playersToAct.every((p) => p.bet === targetBet);
  }

  private advanceStage(): void {
    // Reset bets for new street
    for (const player of this.state.players) {
      player.bet = 0;
    }
    this.state.currentBet = 0;
    this.state.lastRaise = this.config.bigBlind;

    // Deal community cards
    switch (this.state.stage) {
      case 'preflop': {
        this.state.stage = 'flop';
        this.state.sawFlop = true;
        const flop = this.state.deck.deal(3);
        this.state.communityCards.push(...flop);
        this.emit({ type: 'COMMUNITY_CARDS', stage: 'flop', cards: flop });
        break;
      }

      case 'flop': {
        this.state.stage = 'turn';
        const turn = this.state.deck.deal(1);
        this.state.communityCards.push(...turn);
        this.emit({ type: 'COMMUNITY_CARDS', stage: 'turn', cards: turn });
        break;
      }

      case 'turn': {
        this.state.stage = 'river';
        const river = this.state.deck.deal(1);
        this.state.communityCards.push(...river);
        this.emit({ type: 'COMMUNITY_CARDS', stage: 'river', cards: river });
        break;
      }

      case 'river':
        this.state.stage = 'showdown';
        this.completeHand();
        return;
    }

    // Check if we can continue betting
    const activePlayers = this.getActivePlayers().filter((p) => !p.is_all_in);
    if (activePlayers.length < 2) {
      // All but one are all-in, run out community cards
      this.runOutCommunityCards();
      return;
    }

    // Set first player to act post-flop
    this.state.currentPlayerSeat = this.getFirstPostflopPlayer();
    this.emitTurnChange();
  }

  private runOutCommunityCards(): void {
    const activePlayersWithCards = this.state.players.filter(
      (p) => !p.is_folded && !p.is_sitting_out
    );

    // Check if we should pause for Run It Twice
    if (
      this.config.ritEnabled &&
      activePlayersWithCards.length >= 2 &&
      this.state.communityCards.length < 5 &&
      !this.isWaitingForRIT
    ) {
      this.isWaitingForRIT = true;
      this.emit({
        type: 'ALL_IN_RUNOUT_PENDING',
        remainingDeck: this.state.deck.getCards(),
        existingBoard: [...this.state.communityCards],
        pot: this.state.pot,
        activePlayers: activePlayersWithCards,
      });
      return; // Stop the synchronous runout. Engine will call resume() or resolveRIT()
    }

    while (this.state.communityCards.length < 5) {
      const stage =
        this.state.communityCards.length < 3
          ? 'flop'
          : this.state.communityCards.length < 4
            ? 'turn'
            : 'river';
      const count = stage === 'flop' ? 3 - this.state.communityCards.length : 1;
      const cards = this.state.deck.deal(count);
      this.state.communityCards.push(...cards);
      if (stage === 'flop') this.state.sawFlop = true;
      this.emit({ type: 'COMMUNITY_CARDS', stage, cards });
    }
    this.state.stage = 'showdown';
    this.completeHand();
  }

  /**
   * Called by HeadlessTableEngine if RIT is declined or times out
   */
  resumeRunout(): void {
    if (!this.isWaitingForRIT) return;
    this.isWaitingForRIT = false;
    this.runOutCommunityCards();
  }

  /**
   * Called by HeadlessTableEngine if RIT is accepted and completed manually
   */
  resolveRunItTwice(
    board1: Card[],
    board2: Card[],
    customDistributions: { userId: string; amount: number }[]
  ): void {
    if (!this.isWaitingForRIT) return;
    this.isWaitingForRIT = false;
    this.state.stage = 'showdown';

    // Rake applies once to the entire pot
    const rake = calculateRake(
      this.state.pot,
      this.state.sawFlop || board1.length >= 3,
      this.config.rakeConfig
    );
    const totalWinnings = this.state.pot - rake;

    // Adjust distribution amounts based on raked pot
    const totalDistribution = customDistributions.reduce((s, d) => s + d.amount, 0);
    const adjustedWinners: Winner[] = customDistributions.map((d) => ({
      userId: d.userId,
      amount: totalDistribution > 0 ? (d.amount / totalDistribution) * totalWinnings : 0,
    }));

    // Integer (×100) truncation to prevent floating point mismatch
    const totalScaled = Math.trunc(totalWinnings * 100);
    const winScaled = adjustedWinners.map((w) => Math.trunc(w.amount * 100));
    let remainder = totalScaled - winScaled.reduce((s, c) => s + c, 0);
    for (let i = 0; i < winScaled.length && remainder > 0; i++) {
      winScaled[i]++;
      remainder--;
    }
    adjustedWinners.forEach((w, i) => {
      w.amount = winScaled[i] / 100;
      // Add to stacks
      const player = this.state.players.find((p) => p.user_id === w.userId);
      if (player) player.stack += w.amount;
    });

    this.emit({ type: 'WINNERS', winners: adjustedWinners });
    this.emit({
      type: 'HAND_COMPLETE',
      handNumber: this.config.handNumber,
      rake,
      pot: this.state.pot,
      sawFlop: this.state.sawFlop,
    });
    // Telemetry: record hand timing
    engineTelemetry.recordHandTiming(
      this.config.tableId,
      0, // deal time (not separately tracked yet)
      0, // eval time (not separately tracked yet)
      Date.now() - this.handStartedAt
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Hand Completion
  // ─────────────────────────────────────────────────────────────────────────────

  private completeHand(): void {
    const pots = calculatePots(this.state.players);
    this.state.pots = pots;

    const activePlayers = this.getActivePlayers();

    // Showdown if multiple players
    if (activePlayers.length > 1) {
      const evaluator = this.config.gameVariant.startsWith('plo')
        ? evaluateOmahaHand
        : evaluateHand;

      // Filter out players with no cards (shouldn't happen, but defensive)
      const playersWithCards = activePlayers.filter((p) => p.cards && p.cards.length > 0);

      const showdownResults: ShowdownResult[] = playersWithCards.map((p) => ({
        seat: p.seat,
        userId: p.user_id,
        cards: p.cards,
        hand: evaluator(p.cards, this.state.communityCards),
      }));

      this.emit({ type: 'SHOWDOWN', results: showdownResults });
    }

    // Determine winners
    const winners = determineWinners(
      this.state.players,
      this.state.communityCards,
      pots,
      this.config.gameVariant
    );

    // Guard: if no winners (shouldn't happen, but defensive)
    if (winners.length === 0) {
      console.error(
        '[HandController] completeHand: no winners determined — returning pot to players proportionally'
      );
      // Return pot to remaining active players proportionally
      const remainingPlayers = this.state.players.filter((p) => !p.is_folded && !p.is_sitting_out);
      if (remainingPlayers.length > 0) {
        const potScaled = Math.trunc(this.state.pot * 100);
        const shareScaled = Math.trunc(potScaled / remainingPlayers.length);
        const leftoverScaled = potScaled - shareScaled * remainingPlayers.length;
        for (let i = 0; i < remainingPlayers.length; i++) {
          const award = shareScaled + (i < leftoverScaled ? 1 : 0);
          remainingPlayers[i].stack += award / 100;
        }
      }
      this.emit({ type: 'WINNERS', winners: [] });
      this.emit({
        type: 'HAND_COMPLETE',
        handNumber: this.config.handNumber,
        rake: 0,
        pot: this.state.pot,
        sawFlop: this.state.sawFlop,
      });
      // Telemetry: record hand timing (no showdown)
      engineTelemetry.recordHandTiming(this.config.tableId, 0, 0, Date.now() - this.handStartedAt);
      return;
    }

    // Calculate rake
    const rake = calculateRake(this.state.pot, this.state.sawFlop, this.config.rakeConfig);

    // Distribute winnings (minus rake)
    const totalWinnings = this.state.pot - rake;
    const totalWinnerAmount = winners.reduce((sum, w) => sum + w.amount, 0);

    // Integer (×100) arithmetic to prevent floating-point distribution errors
    const totalScaled = Math.trunc(totalWinnings * 100);
    const totalWinnerScaled = Math.trunc(totalWinnerAmount * 100) || 1;
    const adjustedScaled = winners.map((w) =>
      Math.trunc((Math.trunc(w.amount * 100) * totalScaled) / totalWinnerScaled)
    );
    let remainderScaled = totalScaled - adjustedScaled.reduce((s, a) => s + a, 0);
    for (let i = 0; i < adjustedScaled.length && remainderScaled > 0; i++) {
      adjustedScaled[i]++;
      remainderScaled--;
    }
    const adjustedAmounts = adjustedScaled.map((c) => c / 100);
    const adjustedWinners = winners.map((w, i) => ({
      ...w,
      amount: adjustedAmounts[i],
    }));

    // Add winnings to stacks
    for (const winner of adjustedWinners) {
      const player = this.state.players.find((p) => p.user_id === winner.userId);
      if (player) {
        player.stack += winner.amount;
      }
    }

    this.emit({ type: 'WINNERS', winners: adjustedWinners });
    this.emit({
      type: 'HAND_COMPLETE',
      handNumber: this.config.handNumber,
      rake,
      pot: this.state.pot,
      sawFlop: this.state.sawFlop,
    });
    // Telemetry: record hand timing
    engineTelemetry.recordHandTiming(this.config.tableId, 0, 0, Date.now() - this.handStartedAt);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helper Methods
  // ─────────────────────────────────────────────────────────────────────────────

  private getActivePlayers(): SeatPlayer[] {
    return this.state.players.filter((p) => !p.is_folded && !p.is_sitting_out);
  }

  private getNextActiveSeat(fromSeat: number): number {
    const seats = this.state.players
      .filter((p) => !p.is_sitting_out)
      .map((p) => p.seat)
      .sort((a, b) => a - b);

    // Return fromSeat (not -1) so callers don't infinite-loop on a sentinel
    if (seats.length === 0) return fromSeat;

    for (const seat of seats) {
      if (seat > fromSeat) return seat;
    }
    return seats[0]; // Wrap around
  }

  private getFirstPostflopPlayer(): number {
    // Postflop: first active (non-folded, non-all-in) player after dealer
    // This is typically the SB position
    const activePlayers = this.getActivePlayers().filter((p) => !p.is_all_in);
    if (activePlayers.length === 0) return -1;

    let seat = this.getNextActiveSeat(this.state.dealerSeat);
    let iterations = 0;
    const maxIterations = this.state.players.length;

    while (iterations < maxIterations) {
      const player = this.state.players.find((p) => p.seat === seat);
      if (player && !player.is_folded && !player.is_all_in && !player.is_sitting_out) {
        return seat;
      }
      seat = this.getNextActiveSeat(seat);
      iterations++;
    }

    return activePlayers[0]?.seat ?? -1;
  }

  private setNextPlayer(): void {
    const activePlayers = this.getActivePlayers().filter((p) => !p.is_all_in);
    if (activePlayers.length === 0) {
      this.state.currentPlayerSeat = -1;
      return;
    }

    const allActive = this.getActivePlayers();
    const isHeadsUp = allActive.length === 2;

    // First to act preflop: UTG (after BB), or dealer/SB in heads-up
    if (this.state.stage === 'preflop' && this.state.actionHistory.length === 0) {
      if (this.config.straddles && this.config.straddles.length > 0) {
        // If there are straddles, action starts with the player AFTER the last straddle
        const lastStraddleSeat = this.config.straddles[this.config.straddles.length - 1].seat;
        this.state.currentPlayerSeat = this.getNextActiveSeat(lastStraddleSeat);
        return;
      }

      if (isHeadsUp) {
        // Heads-up: dealer/SB acts first preflop
        this.state.currentPlayerSeat = this.state.dealerSeat;
      } else {
        // Multi-way: UTG (player after BB) acts first
        const sbSeat = this.getNextActiveSeat(this.state.dealerSeat);
        const bbSeat = this.getNextActiveSeat(sbSeat);
        this.state.currentPlayerSeat = this.getNextActiveSeat(bbSeat);
      }
      return;
    }

    // Otherwise, next active non-folded, non-all-in player
    let nextSeat = this.getNextActiveSeat(this.state.currentPlayerSeat);
    let iterations = 0;
    const maxIterations = this.state.players.length;

    while (iterations < maxIterations) {
      const player = this.state.players.find((p) => p.seat === nextSeat);
      if (player && !player.is_folded && !player.is_all_in && !player.is_sitting_out) {
        break;
      }
      nextSeat = this.getNextActiveSeat(nextSeat);
      iterations++;
      if (nextSeat === this.state.currentPlayerSeat) break; // Full circle
    }

    // If we looped all the way around without finding a valid seat, set to -1
    const finalPlayer = this.state.players.find((p) => p.seat === nextSeat);
    if (
      finalPlayer &&
      !finalPlayer.is_folded &&
      !finalPlayer.is_all_in &&
      !finalPlayer.is_sitting_out
    ) {
      this.state.currentPlayerSeat = nextSeat;
    } else {
      this.state.currentPlayerSeat = -1;
    }
  }

  private emitTurnChange(): void {
    const player = this.state.players.find((p) => p.seat === this.state.currentPlayerSeat);
    if (!player) return;

    const availableActions = this.getAvailableActions(player);
    this.emit({
      type: 'TURN_CHANGE',
      seat: this.state.currentPlayerSeat,
      availableActions,
    });
  }

  private getAvailableActions(player: SeatPlayer): ActionType[] {
    const actions: ActionType[] = ['fold'];
    const toCall = this.state.currentBet - player.bet;

    if (toCall === 0) {
      actions.push('check');
      if (player.stack > 0) actions.push('bet');
    } else {
      actions.push('call');
      if (player.stack > toCall) actions.push('raise');
    }

    actions.push('all_in');
    return actions;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Getters
  // ─────────────────────────────────────────────────────────────────────────────

  getState(): GameState {
    return {
      ...this.state,
      players: this.state.players.map((p) => ({ ...p, cards: [...p.cards] })),
      communityCards: [...this.state.communityCards],
      pots: this.state.pots.map((p) => ({ ...p, eligiblePlayers: [...p.eligiblePlayers] })),
      actionHistory: [...this.state.actionHistory],
    };
  }

  getCurrentPlayer(): SeatPlayer | undefined {
    return this.state.players.find((p) => p.seat === this.state.currentPlayerSeat);
  }

  getCommunityCards(): Card[] {
    return [...this.state.communityCards];
  }

  getPot(): number {
    return this.state.pot;
  }
}
