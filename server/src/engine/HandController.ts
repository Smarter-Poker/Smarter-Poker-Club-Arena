/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HAND CONTROLLER — Server-Side
 * ═══════════════════════════════════════════════════════════════════════════════
 * Manages the flow of a single poker hand: dealing, betting rounds, showdown.
 * Pure TypeScript, ZERO browser dependencies.
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
} from './PokerEngine.js';
import type {
  Card,
  HandStage,
  SeatPlayer,
  ActionType,
  GameVariant,
  HandConfig,
  GameState,
  ActionRecord,
  HandEvent,
  ShowdownResult,
  EvaluatedHand,
  Pot,
  Winner,
  RakeConfig,
} from '../types.js';

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
    if (config.gameVariant === 'short_deck') {
      deck.removeCardsBelow('6');
    }

    this.state = {
      stage: 'preflop' as HandStage,
      deck: deck as any, // Internal only
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

  // ─────────────────────────────────────────────────────────────────────────
  // Event System
  // ─────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────────────────
  // Start Hand
  // ─────────────────────────────────────────────────────────────────────────

  start(): void {
    this.emit({
      type: 'HAND_START',
      handNumber: this.config.handNumber,
      players: this.state.players,
    });

    if (this.config.bombPot) {
      this.postBombPotAntes();
      this.dealHoleCards();
      // Bible V8 §4.22: Bomb pot skips preflop betting — deal directly to flop
      this.advanceStage(); // preflop → flop, deals 3 community cards, sets first postflop player
      return;
    }

    this.postBlinds();
    this.dealHoleCards();
    this.setNextPlayer();
    this.emitTurnChange();
  }

  private postBlinds(): void {
    const { smallBlind, bigBlind } = this.config;
    const activePlayers = this.getActivePlayers();
    if (activePlayers.length < 2) return;

    const isHeadsUp = activePlayers.length === 2;
    const sbSeat = isHeadsUp
      ? this.state.dealerSeat
      : this.getNextActiveSeat(this.state.dealerSeat);
    const bbSeat = this.getNextActiveSeat(sbSeat);

    const sbPlayer = this.state.players.find((p) => p.seat === sbSeat);
    if (sbPlayer) {
      const sbAmount = Math.min(smallBlind, sbPlayer.stack);
      sbPlayer.bet = sbAmount;
      sbPlayer.totalInvested += sbAmount;
      sbPlayer.stack -= sbAmount;
      this.state.pot += sbAmount;
      if (sbPlayer.stack === 0) sbPlayer.is_all_in = true;
    }

    const bbPlayer = this.state.players.find((p) => p.seat === bbSeat);
    if (bbPlayer) {
      const bbAmount = Math.min(bigBlind, bbPlayer.stack);
      bbPlayer.bet = bbAmount;
      bbPlayer.totalInvested += bbAmount;
      bbPlayer.stack -= bbAmount;
      this.state.pot += bbAmount;
      this.state.currentBet = bbAmount;
      if (bbPlayer.stack === 0) bbPlayer.is_all_in = true;
    }

    if (this.config.ante) {
      if (this.config.bigBlindAnte && bbPlayer) {
        // Bible V8 §4.3: BBA — Big blind posts ante for entire table
        const totalBBA = this.config.ante * activePlayers.length;
        const bbaAmount = Math.min(totalBBA, bbPlayer.stack);
        bbPlayer.totalInvested += bbaAmount;
        bbPlayer.stack -= bbaAmount;
        this.state.pot += bbaAmount;
        if (bbPlayer.stack === 0) bbPlayer.is_all_in = true;
      } else {
        // Traditional ante: each player posts individually
        for (const player of this.state.players.filter((p) => !p.is_sitting_out)) {
          const anteAmount = Math.min(this.config.ante, player.stack);
          player.totalInvested += anteAmount;
          player.stack -= anteAmount;
          this.state.pot += anteAmount;
          if (player.stack === 0) player.is_all_in = true;
        }
      }
    }

    // Bible V8 §4.4: Post straddles after blinds/antes
    if (this.config.straddles && this.config.straddles.length > 0) {
      for (const straddle of this.config.straddles) {
        const straddler = this.state.players.find((p) => p.seat === straddle.seat);
        if (straddler && !straddler.is_sitting_out && straddler.stack >= straddle.amount) {
          const straddleAmount = Math.min(straddle.amount, straddler.stack);
          straddler.bet = straddleAmount;
          straddler.totalInvested += straddleAmount;
          straddler.stack -= straddleAmount;
          this.state.pot += straddleAmount;
          this.state.currentBet = straddleAmount;
          // Straddle is live — straddler can raise when action comes back (§4.4)
          if (straddler.stack === 0) straddler.is_all_in = true;
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
      if (player.stack === 0) player.is_all_in = true;
    }

    this.state.currentBet = 0;
    this.emit({ type: 'POT_UPDATE', pot: this.state.pot, pots: this.state.pots });
  }

  private dealHoleCards(): void {
    const cardsPerPlayer = this.getCardsPerPlayer();
    const deck = this.state.deck as unknown as Deck;

    for (const player of this.state.players.filter((p) => !p.is_sitting_out)) {
      player.cards = deck.deal(cardsPerPlayer);
      this.emit({ type: 'CARDS_DEALT', seat: player.seat, cards: player.cards });
    }
  }

  private getCardsPerPlayer(): number {
    switch (this.config.gameVariant) {
      case 'plo':
      case 'plo4':
        return 4;
      case 'plo5':
        return 5;
      case 'plo6':
        return 6;
      case 'plo8':
        return 4;
      case 'ofc':
      case 'ofc_pineapple':
        return 5;
      default:
        return 2;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Player Actions
  // ─────────────────────────────────────────────────────────────────────────

  performAction(seat: number, action: ActionType, amount?: number): boolean {
    const player = this.state.players.find((p) => p.seat === seat);
    if (!player || seat !== this.state.currentPlayerSeat) return false;

    // Bible V8 §4.14: PLO variants use pot-limit betting
    const isPotLimit = this.config.gameVariant.startsWith('plo');
    const bettingState = calculateBettingState(
      this.state.pot,
      this.state.currentBet,
      player.bet,
      this.config.bigBlind,
      this.state.lastRaise,
      isPotLimit
    );

    const validation = validateAction(action, amount, player.stack, bettingState);
    if (!validation.valid) return false;

    let actualAmount = 0;
    let isFullRaiseFlag: boolean | undefined;

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
        isFullRaiseFlag = true; // Normal bet/raise is always a full raise
        if (raiseSize > this.state.lastRaise) this.state.lastRaise = raiseSize;
        // Bible V8 §4.14: Keep minRaise in sync — must be at least lastRaise or BB
        this.state.minRaise = Math.max(this.config.bigBlind, this.state.lastRaise);
        const chipsAdded = actualAmount - player.bet;
        player.totalInvested += chipsAdded;
        player.stack -= chipsAdded;
        this.state.pot += chipsAdded;
        player.bet = actualAmount;
        this.state.currentBet = actualAmount;
        if (player.stack === 0) player.is_all_in = true;
        break;
      }
      case 'all_in':
        actualAmount = player.stack + player.bet;
        player.totalInvested += player.stack;
        this.state.pot += player.stack;
        player.bet += player.stack;
        player.stack = 0;
        player.is_all_in = true;
        // Bible V8 §4.14: Track whether this all-in constitutes a full raise
        // A short all-in (raise increment < lastRaise) does NOT reopen betting
        if (player.bet > this.state.currentBet) {
          const rs = player.bet - this.state.currentBet;
          isFullRaiseFlag = rs >= this.state.lastRaise;
          if (isFullRaiseFlag) {
            this.state.lastRaise = rs;
            // Bible V8 §4.14: Keep minRaise in sync for full-raise all-ins
            this.state.minRaise = Math.max(this.config.bigBlind, this.state.lastRaise);
          }
          this.state.currentBet = player.bet;
        }
        break;
    }

    this.state.actionHistory.push({
      seat,
      userId: player.user_id,
      action,
      amount: actualAmount,
      timestamp: Date.now(),
      stage: this.state.stage,
      isFullRaise: isFullRaiseFlag,
    });

    this.emit({ type: 'PLAYER_ACTION', seat, action, amount: actualAmount });
    this.emit({ type: 'POT_UPDATE', pot: this.state.pot, pots: calculatePots(this.state.players) });
    this.advanceGame();
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Game Flow
  // ─────────────────────────────────────────────────────────────────────────

  private advanceGame(): void {
    const activePlayers = this.getActivePlayers();
    if (activePlayers.length === 1) {
      this.completeHand();
      return;
    }
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

    if (playersToAct.length === 0) return true;
    if (playersToAct.length === 1) {
      const stageActions = this.state.actionHistory.filter((a) => a.stage === this.state.stage);
      const hasActed = stageActions.some((a) => a.seat === playersToAct[0].seat);
      if (hasActed && playersToAct[0].bet >= this.state.currentBet) return true;
      if (!hasActed) return false;
    }

    const stageActions = this.state.actionHistory.filter((a) => a.stage === this.state.stage);

    // Bible V8 §4.14: Only full raises reopen betting.
    // A short all-in (raise increment < lastRaise) does NOT count as aggression.
    let lastAggressorSeat = -1;
    for (const action of stageActions) {
      if (action.action === 'bet' || action.action === 'raise') {
        // Normal bet/raise always reopens
        lastAggressorSeat = action.seat;
      } else if (action.action === 'all_in' && action.isFullRaise) {
        // All-in only reopens if it was a full raise
        lastAggressorSeat = action.seat;
      }
    }

    for (const player of playersToAct) {
      const playerActions = stageActions.filter((a) => a.seat === player.seat);
      if (playerActions.length === 0) return false;

      if (lastAggressorSeat !== -1 && lastAggressorSeat !== player.seat) {
        let lastAggressorActionIdx = -1;
        for (let i = stageActions.length - 1; i >= 0; i--) {
          const a = stageActions[i];
          if (
            a.seat === lastAggressorSeat &&
            (a.action === 'bet' || a.action === 'raise' || (a.action === 'all_in' && a.isFullRaise))
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
        if (playerLastActionIdx < lastAggressorActionIdx) return false;
      }
    }

    const targetBet = this.state.currentBet;
    return playersToAct.every((p) => p.bet === targetBet);
  }

  private advanceStage(): void {
    for (const player of this.state.players) {
      player.bet = 0;
    }
    this.state.currentBet = 0;
    this.state.lastRaise = this.config.bigBlind;
    this.state.minRaise = this.config.bigBlind;

    const deck = this.state.deck as unknown as Deck;

    switch (this.state.stage) {
      case 'preflop':
        this.state.stage = 'flop';
        this.state.sawFlop = true;
        const flop = deck.deal(3);
        this.state.communityCards.push(...flop);
        this.emit({ type: 'COMMUNITY_CARDS', stage: 'flop', cards: flop });
        break;
      case 'flop':
        this.state.stage = 'turn';
        const turn = deck.deal(1);
        this.state.communityCards.push(...turn);
        this.emit({ type: 'COMMUNITY_CARDS', stage: 'turn', cards: turn });
        break;
      case 'turn':
        this.state.stage = 'river';
        const river = deck.deal(1);
        this.state.communityCards.push(...river);
        this.emit({ type: 'COMMUNITY_CARDS', stage: 'river', cards: river });
        break;
      case 'river':
        this.state.stage = 'showdown';
        this.completeHand();
        return;
    }

    const activePlayers = this.getActivePlayers().filter((p) => !p.is_all_in);
    if (activePlayers.length < 2) {
      this.runOutCommunityCards();
      return;
    }

    this.state.currentPlayerSeat = this.getFirstPostflopPlayer();
    this.emitTurnChange();
  }

  private runOutCommunityCards(): void {
    const deck = this.state.deck as unknown as Deck;
    while (this.state.communityCards.length < 5) {
      const stage =
        this.state.communityCards.length < 3
          ? 'flop'
          : this.state.communityCards.length < 4
            ? 'turn'
            : 'river';
      const count = stage === 'flop' ? 3 - this.state.communityCards.length : 1;
      const cards = deck.deal(count);
      this.state.communityCards.push(...cards);
      this.emit({ type: 'COMMUNITY_CARDS', stage: stage as HandStage, cards });
    }
    this.state.stage = 'showdown';
    this.completeHand();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Hand Completion
  // ─────────────────────────────────────────────────────────────────────────

  private completeHand(): void {
    const pots = calculatePots(this.state.players);
    this.state.pots = pots;
    const activePlayers = this.getActivePlayers();

    if (activePlayers.length > 1) {
      const evaluator = this.config.gameVariant.startsWith('plo')
        ? evaluateOmahaHand
        : evaluateHand;
      const playersWithCards = activePlayers.filter((p) => p.cards && p.cards.length > 0);
      const showdownResults: ShowdownResult[] = playersWithCards.map((p) => ({
        seat: p.seat,
        userId: p.user_id,
        cards: p.cards,
        hand: evaluator(p.cards, this.state.communityCards),
      }));
      this.emit({ type: 'SHOWDOWN', results: showdownResults });
    }

    let winners = determineWinners(
      this.state.players,
      this.state.communityCards,
      pots,
      this.config.gameVariant
    );

    // Bible V8 §1.9 — No-winners guard: if determineWinners returns empty
    // (edge case: all eligible players gone), award pot to last active player
    if (winners.length === 0 && activePlayers.length > 0) {
      console.warn(
        `[HandController] No winners found — awarding pot to last active player ${activePlayers[0].user_id}`
      );
      const totalPot = pots.reduce((sum, p) => sum + p.amount, 0);
      winners = [{ userId: activePlayers[0].user_id, amount: totalPot }];
    }

    const playerCount = this.state.players.filter((p) => !p.is_sitting_out).length;
    const rake = calculateRake(
      this.state.pot,
      this.state.sawFlop,
      this.config.rakeConfig,
      playerCount
    );

    // Bible V8 §1.9 / Appendix A: BBJ fee deducted SIMULTANEOUSLY with rake before distribution
    // BBJ eligibility: must be enabled, hand saw flop (no flop = no BBJ, same as rake),
    // pot >= minPotBB × BB, players dealt >= minPlayersDealt
    let bbjFee = 0;
    const bbjCfg = this.config.bbjConfig;
    if (bbjCfg && bbjCfg.enabled && this.state.sawFlop) {
      const playersDealt = this.state.players.filter((p) => !p.is_sitting_out).length;
      const potInBB = this.state.pot / this.config.bigBlind;
      if (playersDealt >= bbjCfg.minPlayersDealt && potInBB >= bbjCfg.minPotBB) {
        // BBJ fee = BB × feeBB, rounded to nearest cent
        bbjFee = Math.round(this.config.bigBlind * bbjCfg.feeBB * 100) / 100;
      }
    }

    // Guard: total deductions cannot exceed pot (prevent negative winnings)
    // If rake + BBJ > pot, reduce BBJ first, then rake if still over
    if (rake + bbjFee > this.state.pot) {
      const overage = rake + bbjFee - this.state.pot;
      if (overage <= bbjFee) {
        bbjFee = bbjFee - overage;
      } else {
        bbjFee = 0;
        // This should never happen since rake is capped, but just in case
      }
    }
    const totalWinnings = this.state.pot - rake - bbjFee;
    const totalWinnerAmount = winners.reduce((sum, w) => sum + w.amount, 0);

    // If still no winners (impossible edge case), skip distribution to prevent chip loss
    if (winners.length === 0 || totalWinnerAmount === 0) {
      console.error(
        `[HandController] CRITICAL: No winners and no active players — pot of ${this.state.pot} cannot be distributed`
      );
      this.emit({ type: 'WINNERS', winners: [] });
      this.emit({ type: 'HAND_COMPLETE', handNumber: this.config.handNumber, rake: 0, bbjFee: 0 });
      return;
    }

    // Integer-cents arithmetic to prevent floating-point distribution errors
    const totalCents = Math.trunc(totalWinnings * 100);
    const totalWinnerCents = Math.trunc(totalWinnerAmount * 100) || 1;
    const adjustedCents = winners.map((w) =>
      Math.trunc((Math.trunc(w.amount * 100) * totalCents) / totalWinnerCents)
    );
    let remainderCents = totalCents - adjustedCents.reduce((s, a) => s + a, 0);
    for (let i = 0; i < adjustedCents.length && remainderCents > 0; i++) {
      adjustedCents[i]++;
      remainderCents--;
    }
    const adjustedAmounts = adjustedCents.map((c) => c / 100);
    const adjustedWinners = winners.map((w, i) => ({ ...w, amount: adjustedAmounts[i] }));

    for (const winner of adjustedWinners) {
      const player = this.state.players.find((p) => p.user_id === winner.userId);
      if (player) player.stack += winner.amount;
    }

    this.emit({ type: 'WINNERS', winners: adjustedWinners });
    this.emit({ type: 'HAND_COMPLETE', handNumber: this.config.handNumber, rake, bbjFee });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helper Methods
  // ─────────────────────────────────────────────────────────────────────────

  private getActivePlayers(): SeatPlayer[] {
    return this.state.players.filter((p) => !p.is_folded && !p.is_sitting_out);
  }

  private getNextActiveSeat(fromSeat: number): number {
    const seats = this.state.players
      .filter((p) => !p.is_sitting_out)
      .map((p) => p.seat)
      .sort((a, b) => a - b);
    if (seats.length === 0) return -1;
    for (const seat of seats) {
      if (seat > fromSeat) return seat;
    }
    return seats[0];
  }

  private getFirstPostflopPlayer(): number {
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

    if (this.state.stage === 'preflop' && this.state.actionHistory.length === 0) {
      if (isHeadsUp) {
        this.state.currentPlayerSeat = this.state.dealerSeat;
      } else {
        const sbSeat = this.getNextActiveSeat(this.state.dealerSeat);
        const bbSeat = this.getNextActiveSeat(sbSeat);
        // Bible V8 §4.4: If straddles are posted, first to act is left of last straddler
        if (this.config.straddles && this.config.straddles.length > 0) {
          const lastStraddleSeat = this.config.straddles[this.config.straddles.length - 1].seat;
          this.state.currentPlayerSeat = this.getNextActiveSeat(lastStraddleSeat);
        } else {
          this.state.currentPlayerSeat = this.getNextActiveSeat(bbSeat);
        }
      }
      return;
    }

    let nextSeat = this.getNextActiveSeat(this.state.currentPlayerSeat);
    let iterations = 0;
    const maxIterations = this.state.players.length;

    while (iterations < maxIterations) {
      const player = this.state.players.find((p) => p.seat === nextSeat);
      if (player && !player.is_folded && !player.is_all_in && !player.is_sitting_out) break;
      nextSeat = this.getNextActiveSeat(nextSeat);
      iterations++;
      if (nextSeat === this.state.currentPlayerSeat) break;
    }
    this.state.currentPlayerSeat = nextSeat;
  }

  private emitTurnChange(): void {
    const player = this.state.players.find((p) => p.seat === this.state.currentPlayerSeat);
    if (!player) return;
    const availableActions = this.getAvailableActions(player);
    this.emit({ type: 'TURN_CHANGE', seat: this.state.currentPlayerSeat, availableActions });
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

  // ─────────────────────────────────────────────────────────────────────────
  // Getters
  // ─────────────────────────────────────────────────────────────────────────

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
