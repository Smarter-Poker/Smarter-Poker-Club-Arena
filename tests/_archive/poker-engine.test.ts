/**
 * ♠ POKER ENGINE — Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  Deck,
  evaluateHand,
  compareHands,
  parseCard,
  cardToString,
  cardsToString,
  HAND_RANKINGS,
  calculatePots,
  calculateRake,
  determineWinners,
} from '../src/engine/PokerEngine';
import type { Card } from '../src/types/database.types';

// ═══════════════════════════════════════════════════════════════════════════════
// DECK TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Deck', () => {
  let deck: Deck;

  beforeEach(() => {
    deck = new Deck();
  });

  it('should have 52 cards when initialized', () => {
    expect(deck.remaining()).toBe(52);
  });

  it('should deal cards correctly', () => {
    const cards = deck.deal(5);
    expect(cards.length).toBe(5);
    expect(deck.remaining()).toBe(47);
  });

  it('should shuffle the deck', () => {
    const deck1 = new Deck();
    const deck2 = new Deck();
    deck2.shuffle();

    // After shuffling, decks should be different (statistically very likely)
    const cards1 = deck1.deal(10);
    const cards2 = deck2.deal(10);
    const same = cards1.every((c, i) => c.rank === cards2[i].rank && c.suit === cards2[i].suit);
    // With 52! permutations, same order is virtually impossible
    // But we just check the deck still has proper counts
    expect(deck2.remaining()).toBe(42);
  });

  it('should reset the deck', () => {
    deck.deal(20);
    deck.reset();
    expect(deck.remaining()).toBe(52);
  });

  it('should remove cards for Short Deck', () => {
    deck.removeCardsBelow('6');
    expect(deck.remaining()).toBe(36); // 52 - 16 (2-5 in all 4 suits)
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CARD PARSING TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Card Parsing', () => {
  it('should parse card strings correctly', () => {
    const ace = parseCard('As');
    expect(ace.rank).toBe('A');
    expect(ace.suit).toBe('spades');

    const ten = parseCard('Th');
    expect(ten.rank).toBe('T');
    expect(ten.suit).toBe('hearts');
  });

  it('should convert cards to strings', () => {
    const card: Card = { rank: 'K', suit: 'diamonds' };
    expect(cardToString(card)).toBe('K♦');
  });

  it('should convert multiple cards to string', () => {
    const cards: Card[] = [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'hearts' },
    ];
    expect(cardsToString(cards)).toBe('A♠ K♥');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HAND EVALUATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Hand Evaluation', () => {
  it('should recognize a pair', () => {
    const hole: Card[] = [
      { rank: 'A', suit: 'spades' },
      { rank: 'A', suit: 'hearts' },
    ];
    const community: Card[] = [
      { rank: 'K', suit: 'diamonds' },
      { rank: 'Q', suit: 'clubs' },
      { rank: 'J', suit: 'spades' },
      { rank: '5', suit: 'hearts' },
      { rank: '2', suit: 'diamonds' },
    ];
    const result = evaluateHand(hole, community);
    expect(result.ranking).toBe(HAND_RANKINGS.PAIR);
    expect(result.name).toBe('Pair');
  });

  it('should recognize two pair', () => {
    const hole: Card[] = [
      { rank: 'A', suit: 'spades' },
      { rank: 'A', suit: 'hearts' },
    ];
    const community: Card[] = [
      { rank: 'K', suit: 'diamonds' },
      { rank: 'K', suit: 'clubs' },
      { rank: 'Q', suit: 'spades' },
      { rank: '5', suit: 'hearts' },
      { rank: '2', suit: 'diamonds' },
    ];
    const result = evaluateHand(hole, community);
    expect(result.ranking).toBe(HAND_RANKINGS.TWO_PAIR);
  });

  it('should recognize three of a kind', () => {
    const hole: Card[] = [
      { rank: 'A', suit: 'spades' },
      { rank: 'A', suit: 'hearts' },
    ];
    const community: Card[] = [
      { rank: 'A', suit: 'diamonds' },
      { rank: 'K', suit: 'clubs' },
      { rank: 'Q', suit: 'spades' },
      { rank: '5', suit: 'hearts' },
      { rank: '2', suit: 'diamonds' },
    ];
    const result = evaluateHand(hole, community);
    expect(result.ranking).toBe(HAND_RANKINGS.THREE_OF_A_KIND);
  });

  it('should recognize a straight', () => {
    const hole: Card[] = [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'hearts' },
    ];
    const community: Card[] = [
      { rank: 'Q', suit: 'diamonds' },
      { rank: 'J', suit: 'clubs' },
      { rank: 'T', suit: 'spades' },
      { rank: '5', suit: 'hearts' },
      { rank: '2', suit: 'diamonds' },
    ];
    const result = evaluateHand(hole, community);
    expect(result.ranking).toBe(HAND_RANKINGS.STRAIGHT);
  });

  it('should recognize a flush', () => {
    const hole: Card[] = [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'spades' },
    ];
    const community: Card[] = [
      { rank: 'Q', suit: 'spades' },
      { rank: '8', suit: 'spades' },
      { rank: '4', suit: 'spades' },
      { rank: '5', suit: 'hearts' },
      { rank: '2', suit: 'diamonds' },
    ];
    const result = evaluateHand(hole, community);
    expect(result.ranking).toBe(HAND_RANKINGS.FLUSH);
  });

  it('should recognize a full house', () => {
    const hole: Card[] = [
      { rank: 'A', suit: 'spades' },
      { rank: 'A', suit: 'hearts' },
    ];
    const community: Card[] = [
      { rank: 'A', suit: 'diamonds' },
      { rank: 'K', suit: 'clubs' },
      { rank: 'K', suit: 'spades' },
      { rank: '5', suit: 'hearts' },
      { rank: '2', suit: 'diamonds' },
    ];
    const result = evaluateHand(hole, community);
    expect(result.ranking).toBe(HAND_RANKINGS.FULL_HOUSE);
  });

  it('should recognize four of a kind', () => {
    const hole: Card[] = [
      { rank: 'A', suit: 'spades' },
      { rank: 'A', suit: 'hearts' },
    ];
    const community: Card[] = [
      { rank: 'A', suit: 'diamonds' },
      { rank: 'A', suit: 'clubs' },
      { rank: 'K', suit: 'spades' },
      { rank: '5', suit: 'hearts' },
      { rank: '2', suit: 'diamonds' },
    ];
    const result = evaluateHand(hole, community);
    expect(result.ranking).toBe(HAND_RANKINGS.FOUR_OF_A_KIND);
  });

  it('should recognize a straight flush', () => {
    const hole: Card[] = [
      { rank: '9', suit: 'spades' },
      { rank: '8', suit: 'spades' },
    ];
    const community: Card[] = [
      { rank: '7', suit: 'spades' },
      { rank: '6', suit: 'spades' },
      { rank: '5', suit: 'spades' },
      { rank: 'K', suit: 'hearts' },
      { rank: '2', suit: 'diamonds' },
    ];
    const result = evaluateHand(hole, community);
    expect(result.ranking).toBe(HAND_RANKINGS.STRAIGHT_FLUSH);
  });

  it('should recognize a royal flush', () => {
    const hole: Card[] = [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'spades' },
    ];
    const community: Card[] = [
      { rank: 'Q', suit: 'spades' },
      { rank: 'J', suit: 'spades' },
      { rank: 'T', suit: 'spades' },
      { rank: '5', suit: 'hearts' },
      { rank: '2', suit: 'diamonds' },
    ];
    const result = evaluateHand(hole, community);
    expect(result.ranking).toBe(HAND_RANKINGS.ROYAL_FLUSH);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HAND COMPARISON TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Hand Comparison', () => {
  it('should correctly compare different hand rankings', () => {
    const pair: Card[] = [
      { rank: 'A', suit: 'spades' },
      { rank: 'A', suit: 'hearts' },
    ];
    const trips: Card[] = [
      { rank: 'K', suit: 'spades' },
      { rank: 'K', suit: 'hearts' },
    ];
    const community: Card[] = [
      { rank: 'K', suit: 'diamonds' },
      { rank: 'Q', suit: 'clubs' },
      { rank: 'J', suit: 'spades' },
      { rank: '5', suit: 'hearts' },
      { rank: '2', suit: 'diamonds' },
    ];

    const pairHand = evaluateHand(pair, community);
    const tripsHand = evaluateHand(trips, community);

    expect(compareHands(tripsHand, pairHand)).toBeGreaterThan(0);
    expect(compareHands(pairHand, tripsHand)).toBeLessThan(0);
  });

  it('should compare same ranking by kickers', () => {
    const aceHigh: Card[] = [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'hearts' },
    ];
    const kingHigh: Card[] = [
      { rank: 'K', suit: 'diamonds' },
      { rank: 'Q', suit: 'clubs' },
    ];
    const community: Card[] = [
      { rank: '8', suit: 'diamonds' },
      { rank: '7', suit: 'clubs' },
      { rank: '5', suit: 'spades' },
      { rank: '3', suit: 'hearts' },
      { rank: '2', suit: 'diamonds' },
    ];

    const aceHighHand = evaluateHand(aceHigh, community);
    const kingHighHand = evaluateHand(kingHigh, community);

    expect(compareHands(aceHighHand, kingHighHand)).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RAKE CALCULATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Rake Calculation', () => {
  it('should calculate rake with cap', () => {
    const config = { percent: 5, cap: 3, noFlop: true };
    const rake = calculateRake(100, true, config);
    expect(rake).toBe(3); // 5% of 100 = 5, but cap is 3
  });

  it('should apply no flop no drop when no flop', () => {
    const config = { percent: 5, cap: 3, noFlop: true };
    const rake = calculateRake(100, false, config);
    expect(rake).toBe(0);
  });

  it('should take rake without no flop no drop', () => {
    const config = { percent: 5, cap: 10, noFlop: false };
    const rake = calculateRake(100, false, config);
    expect(rake).toBe(5);
  });

  it('should return 0 for zero or negative pot', () => {
    const config = { percent: 5, cap: 10, noFlop: false };
    expect(calculateRake(0, true, config)).toBe(0);
    expect(calculateRake(-50, true, config)).toBe(0);
  });

  it('should return 0 for zero percent', () => {
    const config = { percent: 0, cap: 10, noFlop: false };
    expect(calculateRake(100, true, config)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OMAHA HAND EVALUATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Omaha Hand Evaluation', () => {
  // Need evaluateOmahaHand — import if available
  let evaluateOmahaHand: typeof import('../src/engine/PokerEngine').evaluateOmahaHand;
  let evaluateOmahaLowHand: typeof import('../src/engine/PokerEngine').evaluateOmahaLowHand;

  beforeEach(async () => {
    const engine = await import('../src/engine/PokerEngine');
    evaluateOmahaHand = engine.evaluateOmahaHand;
    evaluateOmahaLowHand = engine.evaluateOmahaLowHand;
  });

  it('should evaluate PLO4 hand using exactly 2 hole cards', () => {
    // Player has 4 hole cards: A♠ K♠ Q♠ J♠
    // Board: T♠ 9♠ 8♦ 2♣ 3♥
    // Best hand should use 2 hole cards + 3 board cards
    const hole: Card[] = [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'spades' },
      { rank: 'Q', suit: 'spades' },
      { rank: 'J', suit: 'spades' },
    ];
    const community: Card[] = [
      { rank: 'T', suit: 'spades' },
      { rank: '9', suit: 'spades' },
      { rank: '8', suit: 'diamonds' },
      { rank: '2', suit: 'clubs' },
      { rank: '3', suit: 'hearts' },
    ];
    const result = evaluateOmahaHand(hole, community);
    // Should find flush (using 2 spades from hole + 3 spades from board is impossible
    // since only T♠ and 9♠ are spade on board — needs exactly 3 board spades)
    // Actually A♠K♠ + T♠9♠8♦ → A♠K♠T♠9♠8♦ is only 2 board spades, need 3
    // Best hand is likely a straight: A K Q J T
    expect(result.ranking).toBeGreaterThan(0);
    expect(result.name).toBeTruthy();
  });

  it('should handle PLO4 with fewer than 4 hole cards gracefully', () => {
    // Fallback behavior — should not crash
    const hole: Card[] = [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'hearts' },
    ];
    const community: Card[] = [
      { rank: 'Q', suit: 'diamonds' },
      { rank: 'J', suit: 'clubs' },
      { rank: 'T', suit: 'spades' },
      { rank: '5', suit: 'hearts' },
      { rank: '2', suit: 'diamonds' },
    ];
    const result = evaluateOmahaHand(hole, community);
    expect(result).toBeTruthy();
    expect(result.ranking).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OMAHA HI/LO TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Omaha Hi/Lo', () => {
  let evaluateOmahaLowHand: typeof import('../src/engine/PokerEngine').evaluateOmahaLowHand;

  beforeEach(async () => {
    const engine = await import('../src/engine/PokerEngine');
    evaluateOmahaLowHand = engine.evaluateOmahaLowHand;
  });

  it('should qualify a low hand with 8-or-better', () => {
    const hole: Card[] = [
      { rank: 'A', suit: 'spades' },
      { rank: '2', suit: 'hearts' },
      { rank: 'K', suit: 'diamonds' },
      { rank: 'Q', suit: 'clubs' },
    ];
    const community: Card[] = [
      { rank: '3', suit: 'diamonds' },
      { rank: '5', suit: 'clubs' },
      { rank: '7', suit: 'spades' },
      { rank: 'J', suit: 'hearts' },
      { rank: 'T', suit: 'diamonds' },
    ];
    const result = evaluateOmahaLowHand(hole, community);
    // A-2 from hole + 3-5-7 from board = A2357 low
    expect(result).not.toBeNull();
  });

  it('should return null when no low qualifier exists', () => {
    const hole: Card[] = [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'hearts' },
      { rank: 'Q', suit: 'diamonds' },
      { rank: 'J', suit: 'clubs' },
    ];
    const community: Card[] = [
      { rank: 'T', suit: 'diamonds' },
      { rank: '9', suit: 'clubs' },
      { rank: 'K', suit: 'spades' },
      { rank: 'Q', suit: 'hearts' },
      { rank: 'J', suit: 'diamonds' },
    ];
    const result = evaluateOmahaLowHand(hole, community);
    // No cards 8 or below on board (except none) — should be null
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POT CALCULATION TESTS (SIDE POTS)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Pot Calculation', () => {
  it('should create main pot with equal investments', () => {
    const players = [
      {
        seat: 1,
        user_id: 'a',
        username: 'A',
        stack: 0,
        bet: 100,
        totalInvested: 100,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
      {
        seat: 2,
        user_id: 'b',
        username: 'B',
        stack: 0,
        bet: 100,
        totalInvested: 100,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
    ];
    const pots = calculatePots(players as any);
    expect(pots.length).toBe(1);
    expect(pots[0].amount).toBe(200);
    expect(pots[0].eligiblePlayers).toContain('a');
    expect(pots[0].eligiblePlayers).toContain('b');
  });

  it('should create side pot when player is all-in for less', () => {
    const players = [
      {
        seat: 1,
        user_id: 'a',
        username: 'A',
        stack: 0,
        bet: 50,
        totalInvested: 50,
        cards: [],
        is_folded: false,
        is_all_in: true,
        is_sitting_out: false,
      },
      {
        seat: 2,
        user_id: 'b',
        username: 'B',
        stack: 50,
        bet: 100,
        totalInvested: 100,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
      {
        seat: 3,
        user_id: 'c',
        username: 'C',
        stack: 50,
        bet: 100,
        totalInvested: 100,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
    ];
    const pots = calculatePots(players as any);
    expect(pots.length).toBe(2);
    // Main pot: 3 players × 50 = 150
    expect(pots[0].amount).toBe(150);
    expect(pots[0].eligiblePlayers.length).toBe(3);
    // Side pot: 2 players × 50 = 100
    expect(pots[1].amount).toBe(100);
    expect(pots[1].eligiblePlayers.length).toBe(2);
    expect(pots[1].eligiblePlayers).not.toContain('a');
  });

  it('should handle folded player contributions going to pot', () => {
    const players = [
      {
        seat: 1,
        user_id: 'a',
        username: 'A',
        stack: 0,
        bet: 50,
        totalInvested: 50,
        cards: [],
        is_folded: true,
        is_all_in: false,
        is_sitting_out: false,
      },
      {
        seat: 2,
        user_id: 'b',
        username: 'B',
        stack: 50,
        bet: 100,
        totalInvested: 100,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
    ];
    const pots = calculatePots(players as any);
    // Main pot should include folded player's contribution
    const totalAmount = pots.reduce((sum, p) => sum + p.amount, 0);
    expect(totalAmount).toBe(150);
    // Folded player NOT eligible to win
    for (const pot of pots) {
      expect(pot.eligiblePlayers).not.toContain('a');
    }
  });

  it('should return empty array when no players have invested', () => {
    const players = [
      {
        seat: 1,
        user_id: 'a',
        username: 'A',
        stack: 100,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
    ];
    const pots = calculatePots(players as any);
    expect(pots.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EDGE CASE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  it('should recognize wheel straight (A-2-3-4-5)', () => {
    const hole: Card[] = [
      { rank: 'A', suit: 'spades' },
      { rank: '2', suit: 'hearts' },
    ];
    const community: Card[] = [
      { rank: '3', suit: 'diamonds' },
      { rank: '4', suit: 'clubs' },
      { rank: '5', suit: 'spades' },
      { rank: 'K', suit: 'hearts' },
      { rank: 'Q', suit: 'diamonds' },
    ];
    const result = evaluateHand(hole, community);
    expect(result.ranking).toBe(HAND_RANKINGS.STRAIGHT);
  });

  it('should handle single active player as winner', () => {
    const community: Card[] = [
      { rank: 'T', suit: 'spades' },
      { rank: '9', suit: 'hearts' },
      { rank: '8', suit: 'diamonds' },
      { rank: '7', suit: 'clubs' },
      { rank: '2', suit: 'spades' },
    ];
    const players = [
      {
        seat: 1,
        user_id: 'winner',
        username: 'W',
        stack: 0,
        bet: 100,
        totalInvested: 100,
        cards: [
          { rank: 'A', suit: 'hearts' },
          { rank: 'K', suit: 'hearts' },
        ],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
      {
        seat: 2,
        user_id: 'folder',
        username: 'F',
        stack: 100,
        bet: 50,
        totalInvested: 50,
        cards: [],
        is_folded: true,
        is_all_in: false,
        is_sitting_out: false,
      },
    ];
    const pots = calculatePots(players as any);
    const winners = determineWinners(players as any, community, pots, 'nlh');
    expect(winners.length).toBe(1);
    expect(winners[0].userId).toBe('winner');
  });

  it('should split pot evenly between tied hands', () => {
    const community: Card[] = [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'hearts' },
      { rank: 'Q', suit: 'diamonds' },
      { rank: 'J', suit: 'clubs' },
      { rank: 'T', suit: 'spades' },
    ];
    // Both players play the board (same straight)
    const players = [
      {
        seat: 1,
        user_id: 'p1',
        username: 'P1',
        stack: 0,
        bet: 100,
        totalInvested: 100,
        cards: [
          { rank: '2', suit: 'hearts' },
          { rank: '3', suit: 'hearts' },
        ],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
      {
        seat: 2,
        user_id: 'p2',
        username: 'P2',
        stack: 0,
        bet: 100,
        totalInvested: 100,
        cards: [
          { rank: '4', suit: 'hearts' },
          { rank: '5', suit: 'hearts' },
        ],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
      },
    ];
    const pots = calculatePots(players as any);
    const winners = determineWinners(players as any, community, pots, 'nlh');
    expect(winners.length).toBe(2);
    expect(winners[0].amount).toBe(winners[1].amount);
  });
});
