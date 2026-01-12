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
    cardsToString,
    type EvaluatedHand,
    type Pot,
    type Winner,
    type RakeConfig,
} from './PokerEngine';
import type {
    Card,
    HandStage,
    SeatPlayer,
    ActionType,
    GameVariant,
} from '../types/database.types';

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
    rakeConfig: RakeConfig;
    bombPot?: {
        anteMultiplier: number; // Each player antes this many BBs
    };
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
    | { type: 'SHOWDOWN'; results: ShowdownResult[] }
    | { type: 'WINNERS'; winners: Winner[] }
    | { type: 'HAND_COMPLETE'; handNumber: number; rake: number };

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

    // ─────────────────────────────────────────────────────────────────────────────
    // Event System
    // ─────────────────────────────────────────────────────────────────────────────

    onEvent(handler: (event: HandEvent) => void): () => void {
        this.eventHandlers.push(handler);
        return () => {
            this.eventHandlers = this.eventHandlers.filter(h => h !== handler);
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
        return players.map(p => ({
            ...p,
            bet: 0,
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
            players: this.state.players
        });

        // Post blinds or bomb pot antes
        if (this.config.bombPot) {
            this.postBombPotAntes();
        } else {
            this.postBlinds();
        }

        // Deal hole cards
        this.dealHoleCards();

        // Set first player to act
        this.setNextPlayer();

        this.emitTurnChange();
    }

    private postBlinds(): void {
        const { smallBlind, bigBlind } = this.config;
        const activePlayers = this.getActivePlayers();

        if (activePlayers.length < 2) return;

        // Find SB and BB positions
        const sbSeat = this.getNextActiveSeat(this.state.dealerSeat);
        const bbSeat = this.getNextActiveSeat(sbSeat);

        // Post small blind
        const sbPlayer = this.state.players.find(p => p.seat === sbSeat);
        if (sbPlayer) {
            const sbAmount = Math.min(smallBlind, sbPlayer.stack);
            sbPlayer.bet = sbAmount;
            sbPlayer.stack -= sbAmount;
            this.state.pot += sbAmount;
        }

        // Post big blind
        const bbPlayer = this.state.players.find(p => p.seat === bbSeat);
        if (bbPlayer) {
            const bbAmount = Math.min(bigBlind, bbPlayer.stack);
            bbPlayer.bet = bbAmount;
            bbPlayer.stack -= bbAmount;
            this.state.pot += bbAmount;
            this.state.currentBet = bbAmount;
        }

        // Post antes if configured
        if (this.config.ante) {
            for (const player of this.state.players.filter(p => !p.is_sitting_out)) {
                const anteAmount = Math.min(this.config.ante, player.stack);
                player.stack -= anteAmount;
                this.state.pot += anteAmount;
            }
        }

        this.emit({ type: 'POT_UPDATE', pot: this.state.pot, pots: this.state.pots });
    }

    private postBombPotAntes(): void {
        const { bigBlind, bombPot } = this.config;
        if (!bombPot) return;

        const anteAmount = bigBlind * bombPot.anteMultiplier;

        for (const player of this.state.players.filter(p => !p.is_sitting_out)) {
            const actualAnte = Math.min(anteAmount, player.stack);
            player.stack -= actualAnte;
            this.state.pot += actualAnte;
        }

        this.state.currentBet = 0;
        this.emit({ type: 'POT_UPDATE', pot: this.state.pot, pots: this.state.pots });
    }

    private dealHoleCards(): void {
        const cardsPerPlayer = this.getCardsPerPlayer();

        for (const player of this.state.players.filter(p => !p.is_sitting_out)) {
            player.cards = this.state.deck.deal(cardsPerPlayer);
            this.emit({ type: 'CARDS_DEALT', seat: player.seat, cards: player.cards });
        }
    }

    private getCardsPerPlayer(): number {
        switch (this.config.gameVariant) {
            case 'plo4': return 4;
            case 'plo5': return 5;
            case 'plo6': return 6;
            case 'plo8': return 4; // Omaha Hi/Lo
            case 'ofc':
            case 'ofc_pineapple':
                return 5; // Initial deal for OFC
            default: return 2; // NLH, FLH, Short Deck
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Player Actions
    // ─────────────────────────────────────────────────────────────────────────────

    performAction(seat: number, action: ActionType, amount?: number): boolean {
        const player = this.state.players.find(p => p.seat === seat);
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
            console.error('Invalid action:', validation.error);
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
                player.stack -= actualAmount;
                this.state.pot += actualAmount;
                if (player.stack === 0) player.is_all_in = true;
                break;

            case 'bet':
            case 'raise':
                actualAmount = amount!;
                const raiseSize = actualAmount - player.bet;
                if (raiseSize > this.state.lastRaise) {
                    this.state.lastRaise = raiseSize;
                }
                player.stack -= (actualAmount - player.bet);
                this.state.pot += (actualAmount - player.bet);
                player.bet = actualAmount;
                this.state.currentBet = actualAmount;
                if (player.stack === 0) player.is_all_in = true;
                break;

            case 'all_in':
                actualAmount = player.stack + player.bet;
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
            amount: actualAmount
        });

        this.emit({
            type: 'POT_UPDATE',
            pot: this.state.pot,
            pots: calculatePots(this.state.players)
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

        // All players must have acted
        const stageActions = this.state.actionHistory.filter(a => a.stage === this.state.stage);
        const actedSeats = new Set(stageActions.map(a => a.seat));

        for (const player of activePlayers) {
            if (!player.is_all_in && !actedSeats.has(player.seat)) {
                return false;
            }
        }

        // All bets must be equalized (except all-ins)
        const playersToCheck = activePlayers.filter(p => !p.is_all_in);
        if (playersToCheck.length === 0) return true;

        const targetBet = this.state.currentBet;
        return playersToCheck.every(p => p.bet === targetBet);
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
            case 'preflop':
                this.state.stage = 'flop';
                this.state.sawFlop = true;
                const flop = this.state.deck.deal(3);
                this.state.communityCards.push(...flop);
                this.emit({ type: 'COMMUNITY_CARDS', stage: 'flop', cards: flop });
                break;

            case 'flop':
                this.state.stage = 'turn';
                const turn = this.state.deck.deal(1);
                this.state.communityCards.push(...turn);
                this.emit({ type: 'COMMUNITY_CARDS', stage: 'turn', cards: turn });
                break;

            case 'turn':
                this.state.stage = 'river';
                const river = this.state.deck.deal(1);
                this.state.communityCards.push(...river);
                this.emit({ type: 'COMMUNITY_CARDS', stage: 'river', cards: river });
                break;

            case 'river':
                this.state.stage = 'showdown';
                this.completeHand();
                return;
        }

        // Check if we can continue betting
        const activePlayers = this.getActivePlayers().filter(p => !p.is_all_in);
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
        while (this.state.communityCards.length < 5) {
            const stage = this.state.communityCards.length < 3 ? 'flop' :
                this.state.communityCards.length < 4 ? 'turn' : 'river';
            const count = stage === 'flop' ? 3 - this.state.communityCards.length : 1;
            const cards = this.state.deck.deal(count);
            this.state.communityCards.push(...cards);
            this.emit({ type: 'COMMUNITY_CARDS', stage, cards });
        }
        this.state.stage = 'showdown';
        this.completeHand();
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

            const showdownResults: ShowdownResult[] = activePlayers.map(p => ({
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

        // Calculate rake
        const rake = calculateRake(
            this.state.pot,
            this.state.sawFlop,
            this.config.rakeConfig
        );

        // Distribute winnings (minus rake)
        const totalWinnings = this.state.pot - rake;
        const adjustedWinners = winners.map(w => ({
            ...w,
            amount: Math.floor(w.amount * (totalWinnings / this.state.pot)),
        }));

        // Add winnings to stacks
        for (const winner of adjustedWinners) {
            const player = this.state.players.find(p => p.user_id === winner.userId);
            if (player) {
                player.stack += winner.amount;
            }
        }

        this.emit({ type: 'WINNERS', winners: adjustedWinners });
        this.emit({ type: 'HAND_COMPLETE', handNumber: this.config.handNumber, rake });
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Helper Methods
    // ─────────────────────────────────────────────────────────────────────────────

    private getActivePlayers(): SeatPlayer[] {
        return this.state.players.filter(p =>
            !p.is_folded && !p.is_sitting_out
        );
    }

    private getNextActiveSeat(fromSeat: number): number {
        const seats = this.state.players
            .filter(p => !p.is_sitting_out)
            .map(p => p.seat)
            .sort((a, b) => a - b);

        if (seats.length === 0) return -1;

        for (const seat of seats) {
            if (seat > fromSeat) return seat;
        }
        return seats[0]; // Wrap around
    }

    private getFirstPostflopPlayer(): number {
        // First active player after dealer
        return this.getNextActiveSeat(this.state.dealerSeat);
    }

    private setNextPlayer(): void {
        const activePlayers = this.getActivePlayers().filter(p => !p.is_all_in);
        if (activePlayers.length === 0) {
            this.state.currentPlayerSeat = -1;
            return;
        }

        // First to act preflop: UTG (after BB)
        if (this.state.stage === 'preflop' && this.state.actionHistory.length === 0) {
            const sbSeat = this.getNextActiveSeat(this.state.dealerSeat);
            const bbSeat = this.getNextActiveSeat(sbSeat);
            this.state.currentPlayerSeat = this.getNextActiveSeat(bbSeat);
            return;
        }

        // Otherwise, next active player
        let nextSeat = this.getNextActiveSeat(this.state.currentPlayerSeat);
        const player = this.state.players.find(p => p.seat === nextSeat);

        while (player && (player.is_folded || player.is_all_in)) {
            nextSeat = this.getNextActiveSeat(nextSeat);
            if (nextSeat === this.state.currentPlayerSeat) break; // Full circle
        }

        this.state.currentPlayerSeat = nextSeat;
    }

    private emitTurnChange(): void {
        const player = this.state.players.find(p => p.seat === this.state.currentPlayerSeat);
        if (!player) return;

        const availableActions = this.getAvailableActions(player);
        this.emit({
            type: 'TURN_CHANGE',
            seat: this.state.currentPlayerSeat,
            availableActions
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
        return { ...this.state };
    }

    getCurrentPlayer(): SeatPlayer | undefined {
        return this.state.players.find(p => p.seat === this.state.currentPlayerSeat);
    }

    getCommunityCards(): Card[] {
        return [...this.state.communityCards];
    }

    getPot(): number {
        return this.state.pot;
    }
}
