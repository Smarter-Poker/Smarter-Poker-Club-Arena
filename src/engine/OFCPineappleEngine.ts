/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🍍 OFC PINEAPPLE ENGINE — Open Face Chinese Poker
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Implements Open Face Chinese Pineapple variant:
 * - 2-4 players
 * - 13 cards per player arranged in 3 rows (Front: 3, Middle: 5, Back: 5)
 * - Progressive dealing (5 initial, then 3 at a time, place 2 discard 1)
 * - Fantasyland bonus round
 * - Royalty scoring
 * - Foul detection
 *
 * RULES:
 * - Back must beat Middle, Middle must beat Front (or foul)
 * - Royalties: Bonus points for premium hands
 * - Fantasyland: QQ+ in front = all 13 cards dealt at once
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type OFCSuit = 'h' | 'd' | 'c' | 's';
export type OFCRank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'T' | 'J' | 'Q' | 'K' | 'A';

export interface OFCCard {
    rank: OFCRank;
    suit: OFCSuit;
}

export type OFCRow = 'front' | 'middle' | 'back';

export interface OFCHand {
    front: OFCCard[];  // 3 cards
    middle: OFCCard[]; // 5 cards
    back: OFCCard[];   // 5 cards
}

export type OFCHandRank =
    | 'high_card' | 'pair' | 'two_pair' | 'trips' | 'straight'
    | 'flush' | 'full_house' | 'quads' | 'straight_flush' | 'royal_flush';

export interface OFCPlayer {
    id: string;
    name: string;
    hand: OFCHand;
    currentCards: OFCCard[]; // Cards to place
    isFantasyland: boolean;
    score: number;
    isFouled: boolean;
}

export interface OFCGameState {
    id: string;
    players: OFCPlayer[];
    deck: OFCCard[];
    currentPlayerIndex: number;
    round: number; // 0 = initial (5 cards), 1-4 = pineapple (3 cards each)
    status: 'waiting' | 'dealing' | 'placing' | 'scoring' | 'finished';
    fantasylandQueue: string[]; // Player IDs who qualified
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const RANKS: OFCRank[] = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS: OFCSuit[] = ['h', 'd', 'c', 's'];

const RANK_VALUES: Record<OFCRank, number> = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

// ═══════════════════════════════════════════════════════════════════════════════
// ROYALTY TABLES
// ═══════════════════════════════════════════════════════════════════════════════

// Front row royalties (only pairs/trips count, it's 3 cards)
export const FRONT_ROYALTIES: Record<string, number> = {
    '66': 1, '77': 2, '88': 3, '99': 4, 'TT': 5, 'JJ': 6,
    'QQ': 7, 'KK': 8, 'AA': 9,
    'trips_222': 10, 'trips_333': 11, 'trips_444': 12, 'trips_555': 13,
    'trips_666': 14, 'trips_777': 15, 'trips_888': 16, 'trips_999': 17,
    'trips_TTT': 18, 'trips_JJJ': 19, 'trips_QQQ': 20, 'trips_KKK': 21, 'trips_AAA': 22,
};

// Middle row royalties
export const MIDDLE_ROYALTIES: Record<OFCHandRank, number> = {
    'high_card': 0, 'pair': 0, 'two_pair': 0, 'trips': 2,
    'straight': 4, 'flush': 8, 'full_house': 12,
    'quads': 20, 'straight_flush': 30, 'royal_flush': 50,
};

// Back row royalties
export const BACK_ROYALTIES: Record<OFCHandRank, number> = {
    'high_card': 0, 'pair': 0, 'two_pair': 0, 'trips': 0,
    'straight': 2, 'flush': 4, 'full_house': 6,
    'quads': 10, 'straight_flush': 15, 'royal_flush': 25,
};

// ═══════════════════════════════════════════════════════════════════════════════
// ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

export const OFCPineappleEngine = {
    // ─────────────────────────────────────────────────────────────────────────────
    // GAME SETUP
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Create a fresh deck
     */
    createDeck(): OFCCard[] {
        const deck: OFCCard[] = [];
        for (const suit of SUITS) {
            for (const rank of RANKS) {
                deck.push({ rank, suit });
            }
        }
        return this.shuffle(deck);
    },

    /**
     * Fisher-Yates shuffle
     */
    shuffle<T>(array: T[]): T[] {
        const arr = [...array];
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    },

    /**
     * Create a new game
     */
    createGame(playerIds: string[], playerNames: string[]): OFCGameState {
        if (playerIds.length < 2 || playerIds.length > 4) {
            throw new Error('OFC requires 2-4 players');
        }

        const deck = this.createDeck();
        const players: OFCPlayer[] = playerIds.map((id, i) => ({
            id,
            name: playerNames[i] || `Player ${i + 1}`,
            hand: { front: [], middle: [], back: [] },
            currentCards: [],
            isFantasyland: false,
            score: 0,
            isFouled: false,
        }));

        return {
            id: crypto.randomUUID(),
            players,
            deck,
            currentPlayerIndex: 0,
            round: 0,
            status: 'waiting',
            fantasylandQueue: [],
        };
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // DEALING
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Deal initial 5 cards to each player
     */
    dealInitialCards(game: OFCGameState): OFCGameState {
        const newGame = { ...game };

        for (const player of newGame.players) {
            if (player.isFantasyland) {
                // Fantasyland: deal all 13 cards + 1 extra (14 total, discard 1)
                player.currentCards = newGame.deck.splice(0, 14);
            } else {
                // Normal: deal 5 cards
                player.currentCards = newGame.deck.splice(0, 5);
            }
        }

        newGame.round = 0;
        newGame.status = 'placing';
        return newGame;
    },

    /**
     * Deal pineapple round (3 cards, place 2, discard 1)
     */
    dealPineappleRound(game: OFCGameState): OFCGameState {
        const newGame = { ...game };

        for (const player of newGame.players) {
            if (!player.isFantasyland && !player.isFouled) {
                player.currentCards = newGame.deck.splice(0, 3);
            }
        }

        newGame.round++;
        newGame.status = 'placing';
        return newGame;
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // CARD PLACEMENT
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Place a card in a row
     */
    placeCard(
        game: OFCGameState,
        playerId: string,
        cardIndex: number,
        row: OFCRow
    ): OFCGameState {
        const newGame = { ...game };
        const player = newGame.players.find(p => p.id === playerId);
        if (!player) throw new Error('Player not found');

        const card = player.currentCards[cardIndex];
        if (!card) throw new Error('Invalid card index');

        // Check row capacity
        const maxCards = row === 'front' ? 3 : 5;
        if (player.hand[row].length >= maxCards) {
            throw new Error(`${row} row is full`);
        }

        // Place card
        player.hand[row] = [...player.hand[row], card];
        player.currentCards = player.currentCards.filter((_, i) => i !== cardIndex);

        return newGame;
    },

    /**
     * Discard a card (for pineapple rounds)
     */
    discardCard(game: OFCGameState, playerId: string, cardIndex: number): OFCGameState {
        const newGame = { ...game };
        const player = newGame.players.find(p => p.id === playerId);
        if (!player) throw new Error('Player not found');

        player.currentCards = player.currentCards.filter((_, i) => i !== cardIndex);
        return newGame;
    },

    /**
     * Check if player has completed their hand
     */
    isHandComplete(player: OFCPlayer): boolean {
        return (
            player.hand.front.length === 3 &&
            player.hand.middle.length === 5 &&
            player.hand.back.length === 5
        );
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // HAND EVALUATION
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Evaluate a 5-card hand
     */
    evaluateHand(cards: OFCCard[]): { rank: OFCHandRank; strength: number } {
        if (cards.length !== 5) {
            throw new Error('Must evaluate exactly 5 cards');
        }

        const sorted = [...cards].sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank]);
        const ranks = sorted.map(c => c.rank);
        const suits = sorted.map(c => c.suit);

        // Check flush
        const isFlush = suits.every(s => s === suits[0]);

        // Check straight
        const values = sorted.map(c => RANK_VALUES[c.rank]);
        let isStraight = false;

        // Regular straight check
        if (values[0] - values[4] === 4 && new Set(values).size === 5) {
            isStraight = true;
        }
        // Wheel (A2345)
        if (ranks.includes('A') && ranks.includes('2') && ranks.includes('3') &&
            ranks.includes('4') && ranks.includes('5')) {
            isStraight = true;
        }

        // Count ranks
        const rankCounts: Record<string, number> = {};
        for (const rank of ranks) {
            rankCounts[rank] = (rankCounts[rank] || 0) + 1;
        }
        const counts = Object.values(rankCounts).sort((a, b) => b - a);

        // Determine hand rank
        let handRank: OFCHandRank;
        let strength = 0;

        if (isStraight && isFlush) {
            if (ranks.includes('A') && ranks.includes('K')) {
                handRank = 'royal_flush';
                strength = 10000;
            } else {
                handRank = 'straight_flush';
                strength = 9000 + values[0];
            }
        } else if (counts[0] === 4) {
            handRank = 'quads';
            strength = 8000 + this.getCountRankValue(rankCounts, 4);
        } else if (counts[0] === 3 && counts[1] === 2) {
            handRank = 'full_house';
            strength = 7000 + this.getCountRankValue(rankCounts, 3) * 100 + this.getCountRankValue(rankCounts, 2);
        } else if (isFlush) {
            handRank = 'flush';
            strength = 6000 + values.reduce((a, b, i) => a + b * Math.pow(15, 4 - i), 0);
        } else if (isStraight) {
            handRank = 'straight';
            strength = 5000 + values[0];
        } else if (counts[0] === 3) {
            handRank = 'trips';
            strength = 4000 + this.getCountRankValue(rankCounts, 3);
        } else if (counts[0] === 2 && counts[1] === 2) {
            handRank = 'two_pair';
            const pairs = Object.entries(rankCounts)
                .filter(([_, count]) => count === 2)
                .map(([rank]) => RANK_VALUES[rank as OFCRank])
                .sort((a, b) => b - a);
            strength = 3000 + pairs[0] * 100 + pairs[1];
        } else if (counts[0] === 2) {
            handRank = 'pair';
            strength = 2000 + this.getCountRankValue(rankCounts, 2);
        } else {
            handRank = 'high_card';
            strength = 1000 + values.reduce((a, b, i) => a + b * Math.pow(15, 4 - i), 0);
        }

        return { rank: handRank, strength };
    },

    /**
     * Evaluate front row (3 cards - only pairs/trips)
     */
    evaluateFront(cards: OFCCard[]): { rank: OFCHandRank; strength: number } {
        if (cards.length !== 3) {
            throw new Error('Front must have exactly 3 cards');
        }

        const sorted = [...cards].sort((a, b) => RANK_VALUES[b.rank] - RANK_VALUES[a.rank]);
        const ranks = sorted.map(c => c.rank);
        const values = sorted.map(c => RANK_VALUES[c.rank]);

        // Count ranks
        const rankCounts: Record<string, number> = {};
        for (const rank of ranks) {
            rankCounts[rank] = (rankCounts[rank] || 0) + 1;
        }
        const counts = Object.values(rankCounts).sort((a, b) => b - a);

        if (counts[0] === 3) {
            return { rank: 'trips', strength: 4000 + values[0] };
        } else if (counts[0] === 2) {
            return { rank: 'pair', strength: 2000 + this.getCountRankValue(rankCounts, 2) };
        } else {
            return { rank: 'high_card', strength: 1000 + values[0] * 100 + values[1] * 10 + values[2] };
        }
    },

    getCountRankValue(counts: Record<string, number>, target: number): number {
        const rank = Object.entries(counts).find(([_, count]) => count === target)?.[0];
        return rank ? RANK_VALUES[rank as OFCRank] : 0;
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // FOUL DETECTION
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Check if hand is fouled (rows not in ascending order)
     */
    isFouled(hand: OFCHand): boolean {
        if (hand.front.length !== 3 || hand.middle.length !== 5 || hand.back.length !== 5) {
            return false; // Not complete yet
        }

        const frontStrength = this.evaluateFront(hand.front).strength;
        const middleStrength = this.evaluateHand(hand.middle).strength;
        const backStrength = this.evaluateHand(hand.back).strength;

        // Back must be >= Middle, Middle must be >= Front
        return !(backStrength >= middleStrength && middleStrength >= frontStrength);
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // ROYALTIES
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Calculate royalties for a complete hand
     */
    calculateRoyalties(hand: OFCHand): { front: number; middle: number; back: number; total: number } {
        if (this.isFouled(hand)) {
            return { front: 0, middle: 0, back: 0, total: 0 };
        }

        // Front royalties
        let frontRoyalty = 0;
        const frontEval = this.evaluateFront(hand.front);
        if (frontEval.rank === 'trips') {
            const tripRank = hand.front[0].rank;
            frontRoyalty = FRONT_ROYALTIES[`trips_${tripRank}${tripRank}${tripRank}`] || 10;
        } else if (frontEval.rank === 'pair') {
            const pairRank = this.getPairRank(hand.front);
            if (pairRank && RANK_VALUES[pairRank] >= 6) {
                frontRoyalty = FRONT_ROYALTIES[`${pairRank}${pairRank}`] || 0;
            }
        }

        // Middle royalties
        const middleEval = this.evaluateHand(hand.middle);
        const middleRoyalty = MIDDLE_ROYALTIES[middleEval.rank];

        // Back royalties
        const backEval = this.evaluateHand(hand.back);
        const backRoyalty = BACK_ROYALTIES[backEval.rank];

        return {
            front: frontRoyalty,
            middle: middleRoyalty,
            back: backRoyalty,
            total: frontRoyalty + middleRoyalty + backRoyalty,
        };
    },

    getPairRank(cards: OFCCard[]): OFCRank | null {
        const counts: Record<string, number> = {};
        for (const card of cards) {
            counts[card.rank] = (counts[card.rank] || 0) + 1;
        }
        const pair = Object.entries(counts).find(([_, count]) => count >= 2);
        return pair ? pair[0] as OFCRank : null;
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // FANTASYLAND
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Check if player qualifies for Fantasyland
     */
    qualifiesForFantasyland(hand: OFCHand): boolean {
        if (this.isFouled(hand)) return false;

        // QQ+ in front qualifies for Fantasyland
        const frontEval = this.evaluateFront(hand.front);
        if (frontEval.rank === 'pair' || frontEval.rank === 'trips') {
            const pairRank = this.getPairRank(hand.front);
            if (pairRank && RANK_VALUES[pairRank] >= RANK_VALUES['Q']) {
                return true;
            }
        }

        return false;
    },

    /**
     * Check if player stays in Fantasyland (stricter requirements)
     */
    staysInFantasyland(hand: OFCHand): boolean {
        if (this.isFouled(hand)) return false;

        // To stay: Trips in front, or Quads+ in back, or Full House+ in middle
        const frontEval = this.evaluateFront(hand.front);
        if (frontEval.rank === 'trips') return true;

        const middleEval = this.evaluateHand(hand.middle);
        if (['full_house', 'quads', 'straight_flush', 'royal_flush'].includes(middleEval.rank)) {
            return true;
        }

        const backEval = this.evaluateHand(hand.back);
        if (['quads', 'straight_flush', 'royal_flush'].includes(backEval.rank)) {
            return true;
        }

        return false;
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // SCORING
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Compare two hands and calculate points exchange
     */
    compareHands(player1: OFCPlayer, player2: OFCPlayer): { p1Points: number; p2Points: number } {
        // If either fouled, they lose 6 points per row to non-fouled opponent
        if (player1.isFouled && player2.isFouled) {
            return { p1Points: 0, p2Points: 0 };
        }

        if (player1.isFouled) {
            return { p1Points: -6, p2Points: 6 };
        }

        if (player2.isFouled) {
            return { p1Points: 6, p2Points: -6 };
        }

        // Compare each row
        let p1Wins = 0;
        let p2Wins = 0;

        // Front
        const front1 = this.evaluateFront(player1.hand.front);
        const front2 = this.evaluateFront(player2.hand.front);
        if (front1.strength > front2.strength) p1Wins++;
        else if (front2.strength > front1.strength) p2Wins++;

        // Middle
        const middle1 = this.evaluateHand(player1.hand.middle);
        const middle2 = this.evaluateHand(player2.hand.middle);
        if (middle1.strength > middle2.strength) p1Wins++;
        else if (middle2.strength > middle1.strength) p2Wins++;

        // Back
        const back1 = this.evaluateHand(player1.hand.back);
        const back2 = this.evaluateHand(player2.hand.back);
        if (back1.strength > back2.strength) p1Wins++;
        else if (back2.strength > back1.strength) p2Wins++;

        // Calculate points
        let p1Points = p1Wins - p2Wins;
        let p2Points = p2Wins - p1Wins;

        // Scoop bonus (win all 3 rows = +3 bonus)
        if (p1Wins === 3) p1Points += 3;
        if (p2Wins === 3) p2Points += 3;

        // Add royalties
        const royalties1 = this.calculateRoyalties(player1.hand);
        const royalties2 = this.calculateRoyalties(player2.hand);
        p1Points += royalties1.total;
        p2Points += royalties2.total;

        return { p1Points, p2Points };
    },

    /**
     * Score a complete game
     */
    scoreGame(game: OFCGameState): OFCGameState {
        const newGame = { ...game };
        const players = newGame.players;

        // Check for fouls
        for (const player of players) {
            player.isFouled = this.isFouled(player.hand);
        }

        // Compare all pairs of players
        for (let i = 0; i < players.length; i++) {
            for (let j = i + 1; j < players.length; j++) {
                const result = this.compareHands(players[i], players[j]);
                players[i].score += result.p1Points;
                players[j].score += result.p2Points;
            }
        }

        // Check Fantasyland qualifications
        newGame.fantasylandQueue = [];
        for (const player of players) {
            if (player.isFantasyland) {
                // Check if stays in Fantasyland
                if (this.staysInFantasyland(player.hand)) {
                    newGame.fantasylandQueue.push(player.id);
                }
            } else {
                // Check if qualifies for Fantasyland
                if (this.qualifiesForFantasyland(player.hand)) {
                    newGame.fantasylandQueue.push(player.id);
                }
            }
        }

        newGame.status = 'finished';
        return newGame;
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // UTILITY
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Card to string representation
     */
    cardToString(card: OFCCard): string {
        const suitSymbols: Record<OFCSuit, string> = { h: '♥', d: '♦', c: '♣', s: '♠' };
        return `${card.rank}${suitSymbols[card.suit]}`;
    },

    /**
     * Hand to string representation
     */
    handToString(hand: OFCHand): string {
        return [
            `Front:  ${hand.front.map(c => this.cardToString(c)).join(' ')}`,
            `Middle: ${hand.middle.map(c => this.cardToString(c)).join(' ')}`,
            `Back:   ${hand.back.map(c => this.cardToString(c)).join(' ')}`,
        ].join('\n');
    },
};

export default OFCPineappleEngine;
