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
import { reportError } from '../services/errorReporter.js';
import { createHandStateMachine, type HandFSMState } from './StateMachine.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HAND CONTROLLER
// ═══════════════════════════════════════════════════════════════════════════════

export class HandController {
  private config: HandConfig;
  private state: GameState;
  private eventHandlers: ((event: HandEvent) => void)[] = [];
  /** FIX 120: Crazy Pineapple — tracks seats that still need to discard after flop */
  private pineappleDiscardsRemaining: Set<number> = new Set();
  /** FIX-225: Bible V8 §1.6/§3.2 — Formal Hand State Machine */
  private handFSM = createHandStateMachine('idle');

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
      lastAggressorSeat: -1, // Bible V8 §4.21: Track for showdown reveal order
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
  // FIX-225: Stage Transition with FSM Validation
  // ─────────────────────────────────────────────────────────────────────────

  /** Map HandStage strings to HandFSMState for validation */
  private static readonly STAGE_TO_FSM: Record<string, HandFSMState> = {
    preflop: 'preflop',
    flop: 'flop',
    pineapple_discard: 'pineapple_discard',
    turn: 'turn',
    river: 'river',
    showdown: 'showdown',
  };

  /**
   * Transition to a new hand stage with FSM validation.
   * The FSM validates the transition is legal per Bible V8 §3.2.
   * If invalid, logs warning but still sets stage (defensive — don't break game).
   */
  private transitionStage(newStage: HandStage): void {
    const fsmState = HandController.STAGE_TO_FSM[newStage];
    if (fsmState) {
      this.handFSM.transition(fsmState);
    }
    this.state.stage = newStage;
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
    // FIX-225: FSM transitions for hand start sequence
    this.handFSM.transition('posting_blinds');

    this.emit({
      type: 'HAND_START',
      handNumber: this.config.handNumber,
      players: this.state.players,
    });

    if (this.config.bombPot) {
      this.postBombPotAntes();
      this.handFSM.transition('dealing');
      this.dealHoleCards();
      // Bible V8 §4.22: Bomb pot skips preflop betting — deal directly to flop
      this.advanceStage(); // preflop → flop, deals 3 community cards, sets first postflop player
      return;
    }

    this.postBlinds();
    this.handFSM.transition('dealing');
    this.dealHoleCards();
    this.handFSM.transition('preflop');
    this.setNextPlayer();
    // AUDIT FIX 2026-07-19: if the blinds/antes put everyone all-in (e.g. HU
    // where both stacks <= their blind), no player can act. Previously
    // emitTurnChange() no-op'd on currentPlayerSeat === -1 and the hand hung
    // until the 10-minute safety void (blinds effectively refunded). Advance
    // straight into the runout instead.
    if (this.state.currentPlayerSeat === -1) {
      this.advanceGame();
    } else {
      this.emitTurnChange();
    }
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

    // Bible V8 §4.2: Dead blinds — players returning from sit-out post SB+BB (SB is dead money)
    if (this.config.deadBlinds && this.config.deadBlinds.length > 0) {
      for (const db of this.config.deadBlinds) {
        const dbPlayer = this.state.players.find((p) => p.seat === db.seat);
        if (dbPlayer && dbPlayer.seat !== sbSeat && dbPlayer.seat !== bbSeat) {
          // Dead SB goes straight to pot (dead money, not a live bet)
          const deadSBAmount = Math.min(smallBlind, dbPlayer.stack);
          dbPlayer.totalInvested += deadSBAmount;
          dbPlayer.stack -= deadSBAmount;
          this.state.pot += deadSBAmount;
          // Live BB — counts as their current bet
          if (dbPlayer.stack > 0) {
            const liveBBAmount = Math.min(bigBlind, dbPlayer.stack);
            dbPlayer.bet = liveBBAmount;
            dbPlayer.totalInvested += liveBBAmount;
            dbPlayer.stack -= liveBBAmount;
            this.state.pot += liveBBAmount;
          }
          if (dbPlayer.stack === 0) dbPlayer.is_all_in = true;
        }
      }
    }

    // AUDIT FIX 2026-07-19: "Post BB to enter" — new players post ONLY a live
    // BB (no dead SB). They act on it like a normal blind.
    if (this.config.bbOnlyPosts && this.config.bbOnlyPosts.length > 0) {
      for (const bp of this.config.bbOnlyPosts) {
        const p = this.state.players.find((pl) => pl.seat === bp.seat);
        if (p && p.seat !== sbSeat && p.seat !== bbSeat && !p.is_sitting_out) {
          const amt = Math.min(bigBlind, p.stack);
          p.bet = amt;
          p.totalInvested += amt;
          p.stack -= amt;
          this.state.pot += amt;
          if (p.stack === 0) p.is_all_in = true;
        }
      }
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
          // AUDIT FIX 2026-07-19: the straddle is a live blind that raises the
          // BB — the minimum raise is to DOUBLE the straddle (4×BB for a 2×BB
          // straddle). Track lastRaise/minRaise = straddle amount so the raise
          // floor is currentBet + straddle (was left at BB → only 3×BB).
          this.state.lastRaise = straddleAmount;
          this.state.minRaise = straddleAmount;
          // Straddle is live — straddler can raise when action comes back (§4.4)
          if (straddler.stack === 0) straddler.is_all_in = true;

          // Phase X5 (2026-04-29) — Bible V8 §1.16 discrete event so the
          // client can render the "STRADDLE" tag + chip-to-pot animation
          // without inferring it from a state-snapshot diff.
          this.emit({
            type: 'STRADDLE_POSTED',
            seat: straddle.seat,
            amount: straddleAmount,
            user_id: straddler.user_id,
          } as never);
        }
      }
    }

    this.emit({ type: 'POT_UPDATE', pot: this.state.pot, pots: this.state.pots });

    // Bible V8 §1.16 (Real-Time Law) — emit a BLINDS_POSTED event so the
    // ServerTableEngine can re-emit it to the WS hub for the chip-to-pot
    // animation. The client must NOT need to diff the snapshot to discover
    // the SB/BB went into the pot.
    const blindsPostings: Array<{ seat: number; type: string; amount: number }> = [];
    if (sbPlayer) {
      const sbAmount = Math.min(smallBlind, sbPlayer.bet); // bet has been set to actual paid
      if (sbAmount > 0)
        blindsPostings.push({ seat: sbSeat, type: 'small_blind', amount: sbAmount });
    }
    if (bbPlayer) {
      const bbAmount = Math.min(bigBlind, bbPlayer.bet);
      if (bbAmount > 0) blindsPostings.push({ seat: bbSeat, type: 'big_blind', amount: bbAmount });
    }
    if (blindsPostings.length > 0) {
      this.emit({ type: 'BLINDS_POSTED', postings: blindsPostings } as any);
    }
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
      // Phase X5 (2026-04-29) — Bible V8 §1.16 hole_cards_dealt private event.
      // ServerTableEngine fans this through to the WS hub as a per-user
      // private message (NOT a public broadcast — only the holder sees the
      // values; spectators see a count-only mask).
      this.emit({
        type: 'HOLE_CARDS_DEALT',
        seat: player.seat,
        user_id: player.user_id,
        cards: player.cards,
        card_count: player.cards.length,
      } as never);
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
        return 4; // Omaha Hi-Lo: 4 cards
      case 'pineapple':
        return 3; // Pineapple: 3 hole cards, discard 1 later
      default:
        return 2; // nlh, short_deck
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
        // FIX 157: Bible V8 §4.14 — raiseSize must be the INCREMENT over the current bet level,
        // NOT the increment over the player's personal bet. Old code used player.bet which was
        // wrong when the player hadn't called yet (e.g., CO raising preflop with bet=0).
        // Correct: raiseSize = newBetLevel - previousBetLevel
        const raiseSize = actualAmount - this.state.currentBet;
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
        // Bible V8 §4.21: Track last aggressor for showdown reveal order
        this.state.lastAggressorSeat = seat;
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
            // Bible V8 §4.21: Full-raise all-in counts as aggression for showdown order
            this.state.lastAggressorSeat = seat;
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

  /**
   * FIX 120: Crazy Pineapple — player discards one of their 3 hole cards after the flop.
   * Called by ServerTableEngine when a player submits a discard action.
   * @param seat - The seat number of the player discarding
   * @param cardIndex - The index (0, 1, or 2) of the card to discard from their hand
   * @returns true if discard was accepted
   */
  performDiscard(seat: number, cardIndex: number): boolean {
    if (this.state.stage !== 'pineapple_discard') {
      return false; // Not in discard phase
    }
    if (!this.pineappleDiscardsRemaining.has(seat)) {
      return false; // Already discarded or not eligible
    }

    const player = this.state.players.find((p) => p.seat === seat);
    if (!player || player.is_folded) {
      this.pineappleDiscardsRemaining.delete(seat);
      this.checkPineappleDiscardsComplete();
      return true;
    }

    if (!player.cards || player.cards.length !== 3) {
      return false; // Invalid state — should have 3 cards
    }
    if (cardIndex < 0 || cardIndex >= player.cards.length) {
      return false; // Invalid card index
    }

    // Remove the selected card from the player's hand
    const discarded = player.cards.splice(cardIndex, 1);
    this.pineappleDiscardsRemaining.delete(seat);

    // Emit discard action for logging
    this.emit({ type: 'PLAYER_ACTION', seat, action: 'discard', amount: 0 });
    // Send updated cards to the player (secure per-player)
    this.emit({ type: 'CARDS_DEALT', seat, cards: [...player.cards] });

    this.checkPineappleDiscardsComplete();
    return true;
  }

  /**
   * FIX 120: Auto-discard for players who didn't respond in time.
   * Discards the last (3rd) card by default.
   */
  autoDiscard(seat: number): boolean {
    return this.performDiscard(seat, 2); // Discard last card
  }

  /** FIX 120: Check if all players have discarded; if so, advance to flop betting */
  private checkPineappleDiscardsComplete(): void {
    if (this.pineappleDiscardsRemaining.size === 0) {
      // All players have discarded — advance to flop betting
      this.advanceStage(); // stage is 'pineapple_discard' → will set to 'flop' and begin betting
    }
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
    // AUDIT V2 (2026-07-23): strict === live-locked the betting round. A call
    // sets player.bet via `bet += (currentBet - bet)`, and IEEE 754 drift can
    // land it at e.g. 15.580000000000002 while currentBet is 15.58. Both
    // players then "match" the bet for all practical purposes, but === says no,
    // so the round never completes and TURN_CHANGE loops until the hand
    // timeout voids the hand. Compare with a half-cent tolerance instead —
    // chip amounts are whole cents per Bible V8 §2.6, so 0.005 can never mask
    // a genuinely unmatched bet.
    return playersToAct.every((p) => Math.abs(p.bet - targetBet) < 0.005);
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
      case 'preflop': {
        this.transitionStage('flop');
        this.state.sawFlop = true;
        const flop = deck.deal(3);
        this.state.communityCards.push(...flop);
        this.emit({ type: 'COMMUNITY_CARDS', stage: 'flop', cards: flop });

        // FIX 120: Crazy Pineapple — after dealing flop, enter discard phase
        if (this.config.gameVariant === 'pineapple') {
          this.transitionStage('pineapple_discard');
          const activePlayers = this.getActivePlayers();
          this.pineappleDiscardsRemaining = new Set(activePlayers.map((p) => p.seat));
          this.emit({
            type: 'PINEAPPLE_DISCARD_REQUIRED',
            seats: [...this.pineappleDiscardsRemaining],
          });
          // Each player will call performDiscard() — no turn rotation needed,
          // all players discard simultaneously. Timer managed by ServerTableEngine.
          return;
        }
        break;
      }
      case 'pineapple_discard':
        // FIX 120: After all discards are in, proceed to flop betting
        this.transitionStage('flop');
        break;
      case 'flop': {
        this.transitionStage('turn');
        const turn = deck.deal(1);
        this.state.communityCards.push(...turn);
        this.emit({ type: 'COMMUNITY_CARDS', stage: 'turn', cards: turn });
        break;
      }
      case 'turn': {
        this.transitionStage('river');
        const river = deck.deal(1);
        this.state.communityCards.push(...river);
        this.emit({ type: 'COMMUNITY_CARDS', stage: 'river', cards: river });
        break;
      }
      case 'river':
        this.transitionStage('showdown');
        this.completeHand();
        return;
    }

    const activePlayers = this.getActivePlayers().filter((p) => !p.is_all_in);
    if (activePlayers.length < 2) {
      // Bible V8 §4.19: Emit ALL_IN_RUNOUT so ServerTableEngine can pause
      // for insurance/RIT offers before dealing remaining cards.
      // ServerTableEngine calls continueRunout() after offers are resolved.
      this.emit({
        type: 'ALL_IN_RUNOUT',
        board: [...this.state.communityCards],
        pot: this.state.pot,
        players: this.getActivePlayers().map((p) => ({ ...p })),
      });
      return;
    }

    this.state.currentPlayerSeat = this.getFirstPostflopPlayer();
    this.emitTurnChange();
  }

  /**
   * Bible V8 §4.19: Public method called by ServerTableEngine AFTER insurance/RIT
   * offers have been resolved. Deals remaining community cards and completes the hand.
   * This is the resumption point after the ALL_IN_RUNOUT pause.
   */
  /**
   * Resume full runout — deals all remaining cards and completes the hand.
   * Used by non-insurance tables for instant runout.
   */
  public continueRunout(): void {
    this.runOutCommunityCards();
  }

  /**
   * Deal exactly ONE street of community cards (flop=3, turn=1, river=1).
   * Returns the new board state. Does NOT complete the hand.
   * Used by insurance tables for per-street pause/offer flow.
   *
   * @returns { board: Card[], stage: string, complete: boolean }
   *   - board: current community cards after dealing
   *   - stage: 'flop' | 'turn' | 'river'
   *   - complete: true if all 5 cards are now dealt (caller should complete the hand)
   */
  public dealNextStreet(): { board: Card[]; stage: string; complete: boolean } {
    const deck = this.state.deck as unknown as Deck;
    const currentLength = this.state.communityCards.length;

    if (currentLength >= 5) {
      return { board: [...this.state.communityCards], stage: 'river', complete: true };
    }

    const stage = currentLength < 3 ? 'flop' : currentLength < 4 ? 'turn' : 'river';
    const count = stage === 'flop' ? 3 - currentLength : 1;
    const cards = deck.deal(count);
    this.state.communityCards.push(...cards);
    this.emit({ type: 'COMMUNITY_CARDS', stage: stage as HandStage, cards });

    const complete = this.state.communityCards.length >= 5;
    return { board: [...this.state.communityCards], stage, complete };
  }

  /**
   * Finalize the hand after all streets are dealt (showdown + settlement).
   * Called by ServerTableEngine after the last street in per-street insurance flow.
   *
   * FIX 117 (restored FIX 109): skipDistribution=true prevents double-money bug.
   * When RIT already distributed pots per-board, we must NOT call completeHand()
   * again because that would re-distribute all pots to winners a SECOND time.
   * Instead, emit HAND_COMPLETE with rake/BBJ fees but skip pot distribution.
   *
   * @param skipDistribution - true when caller (e.g. RIT) already distributed pots
   */
  public finalizeRunout(skipDistribution: boolean = false): void {
    this.transitionStage('showdown');
    if (skipDistribution) {
      // RIT or other caller already distributed pots — just emit completion events
      const playerCount = this.state.players.filter((p) => !p.is_sitting_out).length;
      const rake = calculateRake(
        this.state.pot,
        this.state.sawFlop,
        this.config.rakeConfig,
        playerCount
      );
      let bbjFee = 0;
      const bbjCfg = this.config.bbjConfig;
      if (bbjCfg && bbjCfg.enabled && this.state.sawFlop) {
        const playersDealt = this.state.players.filter((p) => !p.is_sitting_out).length;
        const potInBB = this.state.pot / this.config.bigBlind;
        if (playersDealt >= bbjCfg.minPlayersDealt && potInBB >= bbjCfg.minPotBB) {
          bbjFee = Math.round(this.config.bigBlind * bbjCfg.feeBB * 100) / 100;
        }
      }
      this.emit({ type: 'WINNERS', winners: [] });
      this.handFSM.transition('settlement');
      this.emit({ type: 'HAND_COMPLETE', handNumber: this.config.handNumber, rake, bbjFee });
      this.handFSM.transition('idle');
      return;
    }
    this.completeHand();
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
      // AUDIT V2 (2026-07-23): Crazy Pineapple all-in runout — the discard
      // phase is skipped when everyone is all-in, so players still held THREE
      // hole cards at showdown and evaluateHand scored best-5-of-8, an illegal
      // extra-card advantage. Resolve pending discards as soon as the flop is
      // on the board, exactly where the discard belongs in the hand flow.
      if (this.config.gameVariant === 'pineapple' && this.state.communityCards.length >= 3) {
        this.resolvePendingPineappleDiscards();
      }
    }
    this.transitionStage('showdown');
    this.completeHand();
  }

  /**
   * AUDIT V2 (2026-07-23): Force-resolve outstanding pineapple discards for
   * players who were all-in (or otherwise skipped) before the discard phase.
   * Keeps the best two cards for the player — the same choice any player
   * would make for themselves — so showdown is always a legal 2-card hand.
   */
  private resolvePendingPineappleDiscards(): void {
    const flop = this.state.communityCards.slice(0, 3);
    for (const player of this.state.players) {
      if (player.is_folded || player.cards.length !== 3) continue;
      let bestIdx = 2;
      let bestScore = -1;
      for (let discard = 0; discard < 3; discard++) {
        const keep = player.cards.filter((_, i) => i !== discard);
        const evaluated = evaluateHand(keep, flop);
        const score = evaluated.ranking * 1e6 + (evaluated.kickers[0] || 0) * 1e3 + (evaluated.kickers[1] || 0);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = discard;
        }
      }
      player.cards.splice(bestIdx, 1);
      this.pineappleDiscardsRemaining.delete(player.seat);
      this.emit({ type: 'CARDS_DEALT', seat: player.seat, cards: [...player.cards] });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Hand Completion
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * AUDIT FIX 2026-07-19: Return the uncalled portion of the final bet to the
   * bettor BEFORE forming pots / taking rake — the textbook rule. Previously
   * the excess stayed in `state.pot`, so rake and the BBJ fee were charged on
   * the bettor's own returned chips (e.g. bet 100 into a 20 pot, all fold →
   * rake was taken on 120, not 20), and the proportional payout scaling shaved
   * rake off the refund. Refunding here makes rake, side pots, and chips-in-
   * front all correct at once. Returns the amount refunded (0 if none).
   */
  private returnUncalledBet(): number {
    const invAll = this.state.players.map((p) => ({
      p,
      inv: p.totalInvested ?? p.bet ?? 0,
    }));
    const withMoney = invAll.filter((x) => x.inv > 0);
    if (withMoney.length < 2) {
      // Nobody, or a single contributor (e.g. a walk) — nothing was "called",
      // but there's also no contest, so leave it for the normal award path.
      return 0;
    }
    const sorted = [...withMoney].sort((a, b) => b.inv - a.inv);
    const top = sorted[0];
    const second = sorted[1];
    // Only a UNIQUE, non-folded highest contributor can have an uncalled bet.
    if (top.inv <= second.inv) return 0;
    if (top.p.is_folded) return 0;
    const uncalled = Math.round((top.inv - second.inv) * 100) / 100;
    if (uncalled <= 0) return 0;

    top.p.stack += uncalled;
    top.p.totalInvested = Math.round((top.inv - uncalled) * 100) / 100;
    top.p.bet = Math.max(0, Math.round((top.p.bet - uncalled) * 100) / 100);
    this.state.pot = Math.max(0, Math.round((this.state.pot - uncalled) * 100) / 100);
    this.emit({
      type: 'UNCALLED_BET_RETURNED',
      seat: top.p.seat,
      userId: top.p.user_id,
      amount: uncalled,
    });
    return uncalled;
  }

  private completeHand(): void {
    // Return any uncalled bet to the bettor before rake / pot formation.
    this.returnUncalledBet();

    const pots = calculatePots(this.state.players);
    this.state.pots = pots;
    const activePlayers = this.getActivePlayers();

    if (activePlayers.length > 1) {
      // FIX 122: Pass shortDeck flag so showdown display uses correct hand rankings
      const isShortDeck = this.config.gameVariant === 'short_deck';
      const isOmaha = this.config.gameVariant.startsWith('plo');
      const evaluator = isOmaha
        ? evaluateOmahaHand
        : (h: Card[], c: Card[]) => evaluateHand(h, c, isShortDeck);
      const playersWithCards = activePlayers.filter((p) => p.cards && p.cards.length > 0);
      const showdownResults: ShowdownResult[] = playersWithCards.map((p) => ({
        seat: p.seat,
        userId: p.user_id,
        cards: p.cards,
        hand: evaluator(p.cards, this.state.communityCards),
      }));

      // Bible V8 §4.21: Sort showdown results — last aggressor shows first,
      // then clockwise. If no aggressor, first player left of dealer shows first.
      const firstToShow =
        this.state.lastAggressorSeat >= 0
          ? this.state.lastAggressorSeat
          : this.getFirstPostflopPlayer();
      if (firstToShow >= 0) {
        // FIX 165: Use max physical seat + 1 for modular distance, not player count.
        // Players may have non-contiguous seats (e.g., seats 1,3,5,7 at a 9-seat table).
        // Using players.length would give wrong clockwise distances.
        const maxSeatNum = Math.max(...this.state.players.map((p) => p.seat), firstToShow) + 1;
        showdownResults.sort((a, b) => {
          const aDist = (a.seat - firstToShow + maxSeatNum * 10) % maxSeatNum;
          const bDist = (b.seat - firstToShow + maxSeatNum * 10) % maxSeatNum;
          return aDist - bDist;
        });
      }

      this.emit({ type: 'SHOWDOWN', results: showdownResults });
    }

    // FIX 226: Pass dealerSeat so odd chip allocation is clockwise from dealer
    let winners = determineWinners(
      this.state.players,
      this.state.communityCards,
      pots,
      this.config.gameVariant,
      this.state.dealerSeat
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
      reportError(
        new Error(
          `[HandController] CRITICAL: No winners and no active players — pot of ${this.state.pot} cannot be distributed`
        ),
        'HandController.CRITICAL'
      );
      this.emit({ type: 'WINNERS', winners: [] });
      this.handFSM.transition('settlement');
      this.emit({ type: 'HAND_COMPLETE', handNumber: this.config.handNumber, rake: 0, bbjFee: 0 });
      this.handFSM.transition('idle');
      return;
    }

    // Round 40 audit Pass 3 fix: Integer-cents arithmetic. Use Math.round
    // (NOT Math.trunc) for the float→cents conversion — IEEE 754 drift can
    // make state.pot of "$140.30" actually be 140.29999..., so
    // Math.trunc(140.299... * 100) = 13479, not 13480, leaking exactly 1¢
    // per chop pot whose total had any drift. distributePot already uses
    // Math.round (FIX 179, PokerEngine.ts:652); completeHand was the
    // outlier still on Math.trunc. Verified live: hand 254 (chop pot
    // $134.80 → recorded as 67.40 + 67.39 = $134.79, missing 1¢) is
    // exactly this case.
    //
    // After Math.round, adjustedCents.sum may be over OR under totalCents.
    // Two separate distribute loops handle both directions so the post
    // condition `sum(adjustedCents) === totalCents` always holds.
    const totalCents = Math.round(totalWinnings * 100);
    const totalWinnerCents = Math.round(totalWinnerAmount * 100) || 1;
    const adjustedCents = winners.map((w) =>
      Math.round((Math.round(w.amount * 100) * totalCents) / totalWinnerCents)
    );
    let remainderCents = totalCents - adjustedCents.reduce((s, a) => s + a, 0);
    for (let i = 0; i < adjustedCents.length && remainderCents > 0; i++) {
      adjustedCents[i]++;
      remainderCents--;
    }
    // Round can also overshoot by 1-2 cents on multi-winner pots; pull
    // back evenly without going below 0.
    for (let i = 0; i < adjustedCents.length && remainderCents < 0; i++) {
      if (adjustedCents[i] > 0) {
        adjustedCents[i]--;
        remainderCents++;
      }
    }
    const adjustedAmounts = adjustedCents.map((c) => c / 100);
    const adjustedWinners = winners.map((w, i) => ({ ...w, amount: adjustedAmounts[i] }));

    for (const winner of adjustedWinners) {
      const player = this.state.players.find((p) => p.user_id === winner.userId);
      if (player) player.stack += winner.amount;
    }

    this.emit({ type: 'WINNERS', winners: adjustedWinners });
    this.handFSM.transition('settlement');
    this.emit({ type: 'HAND_COMPLETE', handNumber: this.config.handNumber, rake, bbjFee });
    this.handFSM.transition('idle');
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

  /** Is this seat currently able to act (not folded, all-in, or sitting out)? */
  private isSeatActionable(seat: number): boolean {
    const p = this.state.players.find((x) => x.seat === seat);
    return !!(p && !p.is_folded && !p.is_all_in && !p.is_sitting_out);
  }

  /**
   * Walk clockwise from `fromSeat` to the next seat that can act. If `inclusive`
   * and `fromSeat` itself can act, returns it unchanged. Returns -1 if no seat
   * can act (everyone remaining is all-in / folded / sitting out).
   *
   * AUDIT FIX 2026-07-19: the preflop first-actor branch previously skipped
   * this normalization, so a player who posted an all-in blind (short SB/BB)
   * could be handed the turn and then auto-folded on timeout — forfeiting their
   * pot equity. All turn assignment now flows through here.
   */
  private nextActionableSeat(fromSeat: number, inclusive = false): number {
    if (inclusive && this.isSeatActionable(fromSeat)) return fromSeat;
    let seat = this.getNextActiveSeat(fromSeat);
    let iterations = 0;
    const maxIterations = this.state.players.length + 1;
    while (iterations < maxIterations) {
      if (this.isSeatActionable(seat)) return seat;
      const next = this.getNextActiveSeat(seat);
      if (next === seat) break; // no progress possible
      seat = next;
      iterations++;
      if (seat === fromSeat) break; // full loop, no actionable seat
    }
    return this.isSeatActionable(seat) ? seat : -1;
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
      let candidate: number;
      if (isHeadsUp) {
        candidate = this.state.dealerSeat;
      } else {
        const sbSeat = this.getNextActiveSeat(this.state.dealerSeat);
        const bbSeat = this.getNextActiveSeat(sbSeat);
        // Bible V8 §4.4: If straddles are posted, first to act is left of last straddler
        if (this.config.straddles && this.config.straddles.length > 0) {
          const lastStraddleSeat = this.config.straddles[this.config.straddles.length - 1].seat;
          candidate = this.getNextActiveSeat(lastStraddleSeat);
        } else {
          candidate = this.getNextActiveSeat(bbSeat);
        }
      }
      // Skip past any all-in/folded blind poster to the first player who can act.
      this.state.currentPlayerSeat = this.nextActionableSeat(candidate, true);
      return;
    }

    this.state.currentPlayerSeat = this.nextActionableSeat(this.state.currentPlayerSeat, false);
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

  /**
   * FIX 97: Get remaining deck cards for RIT dual/triple board dealing.
   * Returns a copy of the remaining cards without modifying the deck.
   */
  getRemainingDeck(): import('../types.js').Card[] {
    const deck = this.state.deck as unknown as import('./PokerEngine.js').Deck;
    return deck.getRemainingCards();
  }

  /**
   * FIX 97: Get current pots structure for RIT per-pot resolution.
   */
  getPots(): import('../types.js').Pot[] {
    return this.state.pots.map((p) => ({ ...p, eligiblePlayers: [...p.eligiblePlayers] }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Runout-settlement helpers (shared by ServerTableEngine's RIT path so it
  // uses the SAME uncalled-bet / pot / rake logic as completeHand). AUDIT FIX
  // 2026-07-19: RIT previously read getPots() (empty before completeHand) and
  // distributed the FULL pot with no rake — destroying the pot and minting
  // rake. These expose the canonical pieces.
  // ─────────────────────────────────────────────────────────────────────────

  /** Return the uncalled bet to its bettor (idempotent-ish; call once). */
  public settleUncalledBet(): number {
    return this.returnUncalledBet();
  }

  /** Live side pots computed from current contributions (not the cached ones). */
  public computeLivePots(): import('../types.js').Pot[] {
    return calculatePots(this.state.players);
  }

  /** Rake + BBJ fee for the current pot, using the same rules as completeHand. */
  public computeRakeAndBBJ(): { rake: number; bbjFee: number } {
    const playerCount = this.state.players.filter((p) => !p.is_sitting_out).length;
    const rake = calculateRake(
      this.state.pot,
      this.state.sawFlop,
      this.config.rakeConfig,
      playerCount
    );
    let bbjFee = 0;
    const bbjCfg = this.config.bbjConfig;
    if (bbjCfg && bbjCfg.enabled && this.state.sawFlop) {
      const playersDealt = this.state.players.filter((p) => !p.is_sitting_out).length;
      const potInBB = this.state.pot / this.config.bigBlind;
      if (playersDealt >= bbjCfg.minPlayersDealt && potInBB >= bbjCfg.minPotBB) {
        bbjFee = Math.round(this.config.bigBlind * bbjCfg.feeBB * 100) / 100;
      }
    }
    if (rake + bbjFee > this.state.pot) {
      const overage = rake + bbjFee - this.state.pot;
      bbjFee = overage <= bbjFee ? bbjFee - overage : 0;
    }
    return { rake, bbjFee };
  }

  /** Dealer seat (for odd-chip allocation in RIT). */
  public getDealerSeat(): number {
    return this.state.dealerSeat;
  }

  /** Variant for this hand. */
  public getVariant(): import('../types.js').GameVariant {
    return this.config.gameVariant;
  }
}
