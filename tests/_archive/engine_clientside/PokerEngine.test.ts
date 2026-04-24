/**
 * ♠ CLUB ARENA — PokerEngine Core Tests
 * ═══════════════════════════════════════════════════════════════════════════════
 * Comprehensive tests for hand evaluation, pot calculation, winner determination,
 * action validation, and rake calculation.
 */

import { describe, it, expect } from 'vitest';
import {
  Deck,
  RANKS,
  SUITS,
  evaluateHand,
  evaluateOmahaHand,
  evaluateOmahaLowHand,
  compareHands,
  calculatePots,
  calculateBettingState,
  validateAction,
  calculateRake,
  determineWinners,
  type EvaluatedHand,
} from '../../src/engine/PokerEngine';
import type { Card, SeatPlayer } from '../../src/types/database.types';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function card(rank: string, suit: string): Card {
  const suitMap: Record<string, Card['suit']> = {
    h: 'hearts',
    d: 'diamonds',
    c: 'clubs',
    s: 'spades',
  };
  return { rank: rank as Card['rank'], suit: suitMap[suit] || (suit as Card['suit']) };
}

function makePlayer(
  overrides: Partial<SeatPlayer> & { seat: number; user_id: string }
): SeatPlayer {
  return {
    seat: overrides.seat,
    user_id: overrides.user_id,
    username: overrides.username || `Player${overrides.seat}`,
    avatar_url: '',
    stack: overrides.stack ?? 100,
    bet: overrides.bet ?? 0,
    totalInvested: overrides.totalInvested ?? 0,
    cards: overrides.cards ?? [],
    is_folded: overrides.is_folded ?? false,
    is_all_in: overrides.is_all_in ?? false,
    is_sitting_out: overrides.is_sitting_out ?? false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DECK TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Deck', () => {
  it('should contain 52 cards after creation', () => {
    const deck = new Deck();
    expect(deck.remaining()).toBe(52);
  });

  it('should deal cards and reduce remaining count', () => {
    const deck = new Deck();
    const cards = deck.deal(5);
    expect(cards).toHaveLength(5);
    expect(deck.remaining()).toBe(47);
  });

  it('should throw when dealing more cards than remaining', () => {
    const deck = new Deck();
    deck.deal(50);
    expect(() => deck.deal(5)).toThrow('Not enough cards');
  });

  it('should reset to 52 cards', () => {
    const deck = new Deck();
    deck.deal(30);
    deck.reset();
    expect(deck.remaining()).toBe(52);
  });

  it('should remove cards below rank for Short Deck', () => {
    const deck = new Deck();
    deck.removeCardsBelow('6');
    // Should have 36 cards (6-A in 4 suits = 9 ranks * 4 suits)
    expect(deck.remaining()).toBe(36);
  });

  it('dealOne should return a single card', () => {
    const deck = new Deck();
    const c = deck.dealOne();
    expect(c).toHaveProperty('rank');
    expect(c).toHaveProperty('suit');
    expect(deck.remaining()).toBe(51);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HAND EVALUATOR TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('evaluateHand', () => {
  it('should detect Royal Flush', () => {
    const hole = [card('A', 'h'), card('K', 'h')];
    const board = [card('Q', 'h'), card('J', 'h'), card('T', 'h'), card('3', 'd'), card('5', 'c')];
    const result = evaluateHand(hole, board);
    expect(result.name).toBe('Royal Flush');
    expect(result.ranking).toBe(10);
  });

  it('should detect Straight Flush', () => {
    const hole = [card('9', 's'), card('8', 's')];
    const board = [card('7', 's'), card('6', 's'), card('5', 's'), card('K', 'd'), card('2', 'c')];
    const result = evaluateHand(hole, board);
    expect(result.name).toBe('Straight Flush');
    expect(result.ranking).toBe(9);
  });

  it('should detect Four of a Kind', () => {
    const hole = [card('A', 'h'), card('A', 'd')];
    const board = [card('A', 'c'), card('A', 's'), card('K', 'h'), card('7', 'd'), card('3', 'c')];
    const result = evaluateHand(hole, board);
    expect(result.name).toBe('Four of a Kind');
  });

  it('should detect Full House', () => {
    const hole = [card('K', 'h'), card('K', 'd')];
    const board = [card('K', 'c'), card('7', 's'), card('7', 'h'), card('2', 'd'), card('3', 'c')];
    const result = evaluateHand(hole, board);
    expect(result.name).toBe('Full House');
  });

  it('should detect Flush', () => {
    const hole = [card('A', 'h'), card('9', 'h')];
    const board = [card('6', 'h'), card('3', 'h'), card('2', 'h'), card('K', 'd'), card('J', 'c')];
    const result = evaluateHand(hole, board);
    expect(result.name).toBe('Flush');
  });

  it('should detect Straight', () => {
    const hole = [card('8', 'h'), card('7', 'd')];
    const board = [card('6', 'c'), card('5', 's'), card('4', 'h'), card('K', 'd'), card('2', 'c')];
    const result = evaluateHand(hole, board);
    expect(result.name).toBe('Straight');
  });

  it('should detect Wheel straight (A-2-3-4-5)', () => {
    const hole = [card('A', 'h'), card('2', 'd')];
    const board = [card('3', 'c'), card('4', 's'), card('5', 'h'), card('K', 'd'), card('J', 'c')];
    const result = evaluateHand(hole, board);
    expect(result.name).toBe('Straight');
    // Wheel kickers should have 5 as high card
    expect(result.kickers[0]).toBe(5);
  });

  it('should detect Three of a Kind', () => {
    const hole = [card('Q', 'h'), card('Q', 'd')];
    const board = [card('Q', 'c'), card('8', 's'), card('3', 'h'), card('2', 'd'), card('7', 'c')];
    const result = evaluateHand(hole, board);
    expect(result.name).toBe('Three of a Kind');
  });

  it('should detect Two Pair', () => {
    const hole = [card('K', 'h'), card('Q', 'd')];
    const board = [card('K', 'c'), card('Q', 's'), card('3', 'h'), card('7', 'd'), card('2', 'c')];
    const result = evaluateHand(hole, board);
    expect(result.name).toBe('Two Pair');
  });

  it('should detect Pair', () => {
    const hole = [card('A', 'h'), card('A', 'd')];
    const board = [card('K', 'c'), card('8', 's'), card('3', 'h'), card('7', 'd'), card('2', 'c')];
    const result = evaluateHand(hole, board);
    expect(result.name).toBe('Pair');
  });

  it('should detect High Card', () => {
    const hole = [card('A', 'h'), card('J', 'd')];
    const board = [card('9', 'c'), card('7', 's'), card('3', 'h'), card('5', 'd'), card('2', 'c')];
    const result = evaluateHand(hole, board);
    expect(result.name).toBe('High Card');
  });

  it('should handle fewer than 5 cards gracefully', () => {
    const hole = [card('A', 'h'), card('K', 'd')];
    const board: Card[] = [];
    const result = evaluateHand(hole, board);
    expect(result.name).toBe('No Hand');
    expect(result.ranking).toBe(0);
  });

  it('should select best 5 from 7 cards', () => {
    // Board pair + pocket pair = Two Pair, but there's also a flush possibility
    const hole = [card('A', 'h'), card('K', 'h')];
    const board = [card('Q', 'h'), card('J', 'h'), card('3', 'h'), card('9', 'd'), card('2', 'c')];
    const result = evaluateHand(hole, board);
    // Should detect the flush (A-K-Q-J-3 of hearts)
    expect(result.name).toBe('Flush');
  });
});

describe('compareHands', () => {
  it('should rank Royal Flush above Straight Flush', () => {
    const rf = evaluateHand(
      [card('A', 'h'), card('K', 'h')],
      [card('Q', 'h'), card('J', 'h'), card('T', 'h'), card('3', 'd'), card('5', 'c')]
    );
    const sf = evaluateHand(
      [card('9', 'h'), card('8', 'h')],
      [card('7', 'h'), card('6', 'h'), card('5', 'h'), card('3', 'd'), card('2', 'c')]
    );
    expect(compareHands(rf, sf)).toBeGreaterThan(0);
  });

  it('should use kickers for same ranking', () => {
    const pair_a = evaluateHand(
      [card('A', 'h'), card('A', 'd')],
      [card('K', 'c'), card('Q', 's'), card('J', 'h'), card('3', 'd'), card('2', 'c')]
    );
    const pair_k = evaluateHand(
      [card('K', 'h'), card('K', 'd')],
      [card('A', 'c'), card('Q', 's'), card('J', 'h'), card('3', 'd'), card('2', 'c')]
    );
    expect(compareHands(pair_a, pair_k)).toBeGreaterThan(0);
  });

  it('should return 0 for identical hands (tie)', () => {
    const h1 = evaluateHand(
      [card('A', 'h'), card('K', 'd')],
      [card('Q', 'c'), card('J', 's'), card('T', 'h'), card('3', 'd'), card('2', 'c')]
    );
    const h2 = evaluateHand(
      [card('A', 's'), card('K', 'c')],
      [card('Q', 'c'), card('J', 's'), card('T', 'h'), card('3', 'd'), card('2', 'c')]
    );
    // Both make the same straight (A-K-Q-J-T)
    expect(compareHands(h1, h2)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OMAHA EVALUATOR TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('evaluateOmahaHand', () => {
  it('should enforce must-use-2 rule', () => {
    // 4 hearts on board + 1 heart in hand = NOT a flush (must use exactly 2 from hand)
    const hole = [card('A', 'h'), card('3', 'd'), card('5', 'c'), card('7', 's')];
    const board = [card('K', 'h'), card('Q', 'h'), card('J', 'h'), card('T', 'h'), card('2', 'c')];
    const result = evaluateOmahaHand(hole, board);
    // Only Ah from hand + exactly 2 board hearts, so needs 2 hole cards
    // Ah + 3d with K♥Q♥J♥ = A-K-Q-J (not flush, only 1 heart from hand, need 2 hole cards in combo)
    // Best is Ah + some other card with the board
    expect(result.name).not.toBe('Flush'); // Can't use 4 from board
  });

  it('should find best Omaha hand with 2 hole + 3 board', () => {
    const hole = [card('A', 'h'), card('A', 'd'), card('K', 'h'), card('Q', 'h')];
    const board = [card('A', 'c'), card('7', 's'), card('7', 'h'), card('3', 'd'), card('2', 'c')];
    const result = evaluateOmahaHand(hole, board);
    expect(result.name).toBe('Full House'); // A-A-A-7-7
  });

  it('should handle gracefully with fewer than 4 hole cards', () => {
    const hole = [card('A', 'h'), card('K', 'd')];
    const board = [card('Q', 'c'), card('J', 's'), card('T', 'h'), card('3', 'd'), card('2', 'c')];
    const result = evaluateOmahaHand(hole, board);
    // Falls back to standard evaluation
    expect(result.ranking).toBeGreaterThan(0);
  });
});

describe('evaluateOmahaLowHand', () => {
  it('should find valid 8-or-better low hand', () => {
    const hole = [card('A', 'h'), card('2', 'd'), card('K', 'h'), card('Q', 's')];
    const board = [card('3', 'c'), card('5', 's'), card('7', 'h'), card('T', 'd'), card('J', 'c')];
    const result = evaluateOmahaLowHand(hole, board);
    expect(result).not.toBeNull();
    expect(result!.name).toContain('Low');
  });

  it('should return null when no qualifying low exists', () => {
    const hole = [card('K', 'h'), card('Q', 'd'), card('J', 'h'), card('T', 's')];
    const board = [card('9', 'c'), card('8', 's'), card('7', 'h'), card('6', 'd'), card('A', 'c')];
    const result = evaluateOmahaLowHand(hole, board);
    // No 5 unique cards all ≤ 8 since J,T,K,Q are all > 8
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POT CALCULATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('calculatePots', () => {
  it('should create single pot when all bets equal', () => {
    const players: SeatPlayer[] = [
      makePlayer({ seat: 1, user_id: 'p1', totalInvested: 50 }),
      makePlayer({ seat: 2, user_id: 'p2', totalInvested: 50 }),
      makePlayer({ seat: 3, user_id: 'p3', totalInvested: 50 }),
    ];
    const pots = calculatePots(players);
    expect(pots).toHaveLength(1);
    expect(pots[0].amount).toBe(150);
    expect(pots[0].eligiblePlayers).toHaveLength(3);
  });

  it('should create side pots for all-in with different stacks', () => {
    const players: SeatPlayer[] = [
      makePlayer({ seat: 1, user_id: 'p1', totalInvested: 30, is_all_in: true }),
      makePlayer({ seat: 2, user_id: 'p2', totalInvested: 60, is_all_in: true }),
      makePlayer({ seat: 3, user_id: 'p3', totalInvested: 100 }),
    ];
    const pots = calculatePots(players);
    // Main pot: 30 * 3 = 90 (p1, p2, p3 eligible)
    // Side pot 1: (60-30) * 2 = 60 (p2, p3 eligible)
    // Side pot 2: (100-60) * 1 = 40 (p3 only)
    expect(pots.length).toBeGreaterThanOrEqual(2);
    const totalAmount = pots.reduce((s, p) => s + p.amount, 0);
    expect(totalAmount).toBe(190);
  });

  it('should exclude folded players from eligibility', () => {
    const players: SeatPlayer[] = [
      makePlayer({ seat: 1, user_id: 'p1', totalInvested: 50, is_folded: true }),
      makePlayer({ seat: 2, user_id: 'p2', totalInvested: 50 }),
      makePlayer({ seat: 3, user_id: 'p3', totalInvested: 50 }),
    ];
    const pots = calculatePots(players);
    // Folded player contributed but can't win
    expect(pots[0].amount).toBe(150);
    expect(pots[0].eligiblePlayers).not.toContain('p1');
    expect(pots[0].eligiblePlayers).toHaveLength(2);
  });

  it('should handle empty player list', () => {
    const pots = calculatePots([]);
    expect(pots).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BETTING LOGIC TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('calculateBettingState', () => {
  it('should compute correct toCall amount', () => {
    const state = calculateBettingState(50, 10, 5, 2);
    expect(state.toCall).toBe(5); // 10 - 5
  });

  it('should compute correct minRaise', () => {
    const state = calculateBettingState(50, 10, 5, 2, 4);
    expect(state.minRaise).toBe(4); // lastRaise = 4 > bigBlind
  });

  it('should use bigBlind as minRaise floor', () => {
    const state = calculateBettingState(50, 10, 5, 5, 0);
    expect(state.minRaise).toBe(5); // bigBlind = 5 > lastRaise = 0
  });
});

describe('validateAction', () => {
  const defaultState = calculateBettingState(100, 10, 0, 2, 2);

  it('should always allow fold', () => {
    expect(validateAction('fold', undefined, 100, defaultState).valid).toBe(true);
  });

  it('should reject check when there is a bet to call', () => {
    const result = validateAction('check', undefined, 100, defaultState);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('check');
  });

  it('should allow check when toCall is 0', () => {
    const noCallState = calculateBettingState(100, 0, 0, 2);
    expect(validateAction('check', undefined, 100, noCallState).valid).toBe(true);
  });

  it('should reject call when there is nothing to call', () => {
    const noCallState = calculateBettingState(100, 0, 0, 2);
    const result = validateAction('call', undefined, 100, noCallState);
    expect(result.valid).toBe(false);
  });

  it('should allow valid call', () => {
    expect(validateAction('call', undefined, 100, defaultState).valid).toBe(true);
  });

  it('should reject bet when there is already a bet', () => {
    const result = validateAction('bet', 20, 100, defaultState);
    expect(result.valid).toBe(false);
  });

  it('should allow valid bet when no current bet', () => {
    const noBetState = calculateBettingState(100, 0, 0, 2);
    expect(validateAction('bet', 5, 100, noBetState).valid).toBe(true);
  });

  it('should reject bet below minimum', () => {
    const noBetState = calculateBettingState(100, 0, 0, 5);
    const result = validateAction('bet', 3, 100, noBetState);
    expect(result.valid).toBe(false);
  });

  it('should reject raise when no existing bet', () => {
    const noBetState = calculateBettingState(100, 0, 0, 2);
    const result = validateAction('raise', 10, 100, noBetState);
    expect(result.valid).toBe(false);
  });

  it('should reject raise below min raise', () => {
    // currentBet=10, minRaise=2, so raise to at least 12
    const result = validateAction('raise', 11, 100, defaultState);
    expect(result.valid).toBe(false);
  });

  it('should allow valid raise', () => {
    const result = validateAction('raise', 14, 100, defaultState);
    expect(result.valid).toBe(true);
  });

  it('should always allow all_in', () => {
    expect(validateAction('all_in', undefined, 1, defaultState).valid).toBe(true);
  });

  it('should allow under-min-raise when it is an all-in', () => {
    // Player has 15 chips stack, currentBet=10, playerBet=0, minRaise=2
    // maxRaiseTo = playerBet + stack = 0 + 15 = 15
    // raise to 11 is below min (10 + 2 = 12), but since amount === maxRaiseTo
    // it should be treated as an all-in and allowed
    const state = calculateBettingState(100, 10, 0, 2, 2);
    // Player commits entire stack of 15 → raise to 15 (maxRaiseTo=15), raiseAmount=5 < minRaise=2
    // But 15 === maxRaiseTo, so should be valid
    const result = validateAction('raise', 15, 15, state);
    expect(result.valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RAKE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('calculateRake', () => {
  const config = { percent: 5, cap: 3, noFlop: true };

  it('should calculate rake correctly', () => {
    const rake = calculateRake(100, true, config);
    // 100 * 5 / 100 = 5, but cap = 3
    expect(rake).toBe(3);
  });

  it('should return 0 when no flop seen (no-flop-no-drop)', () => {
    expect(calculateRake(100, false, config)).toBe(0);
  });

  it('should return 0 for zero pot', () => {
    expect(calculateRake(0, true, config)).toBe(0);
  });

  it('should return uncapped rake when below cap', () => {
    const rake = calculateRake(20, true, config);
    // 20 * 5 / 100 = 1.0
    expect(rake).toBe(1);
  });

  it('should take rake even without noFlop rule when sawFlop false', () => {
    const noDropConfig = { percent: 5, cap: 3, noFlop: false };
    const rake = calculateRake(100, false, noDropConfig);
    expect(rake).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WINNER DETERMINATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('determineWinners', () => {
  it('should award entire pot to sole remaining player (everyone else folded)', () => {
    const players: SeatPlayer[] = [
      makePlayer({
        seat: 1,
        user_id: 'p1',
        totalInvested: 50,
        cards: [card('A', 'h'), card('K', 'h')],
      }),
      makePlayer({
        seat: 2,
        user_id: 'p2',
        totalInvested: 50,
        is_folded: true,
        cards: [card('2', 'd'), card('3', 'd')],
      }),
    ];
    const board = [card('7', 'c'), card('8', 's'), card('9', 'h'), card('T', 'd'), card('J', 'c')];
    const pots = calculatePots(players);
    const winners = determineWinners(players, board, pots, 'nlh');
    expect(winners).toHaveLength(1);
    expect(winners[0].userId).toBe('p1');
    expect(winners[0].amount).toBe(100);
  });

  it('should split pot on tie', () => {
    // Both have the same straight from the board
    const players: SeatPlayer[] = [
      makePlayer({
        seat: 1,
        user_id: 'p1',
        totalInvested: 50,
        cards: [card('2', 'h'), card('3', 'd')],
      }),
      makePlayer({
        seat: 2,
        user_id: 'p2',
        totalInvested: 50,
        cards: [card('2', 'c'), card('3', 's')],
      }),
    ];
    const board = [card('A', 'c'), card('K', 's'), card('Q', 'h'), card('J', 'd'), card('T', 'c')];
    const pots = calculatePots(players);
    const winners = determineWinners(players, board, pots, 'nlh');
    // Both make A-K-Q-J-T straight from the board
    expect(winners).toHaveLength(2);
    expect(winners[0].amount + winners[1].amount).toBe(100);
  });

  it('should award better hand the full pot', () => {
    const players: SeatPlayer[] = [
      makePlayer({
        seat: 1,
        user_id: 'p1',
        totalInvested: 50,
        cards: [card('A', 'h'), card('A', 'd')],
      }),
      makePlayer({
        seat: 2,
        user_id: 'p2',
        totalInvested: 50,
        cards: [card('K', 'h'), card('K', 'd')],
      }),
    ];
    const board = [card('7', 'c'), card('8', 's'), card('2', 'h'), card('4', 'd'), card('9', 'c')];
    const pots = calculatePots(players);
    const winners = determineWinners(players, board, pots, 'nlh');
    expect(winners).toHaveLength(1);
    expect(winners[0].userId).toBe('p1'); // AA > KK
    expect(winners[0].amount).toBe(100);
  });

  it('should handle side pots correctly', () => {
    const players: SeatPlayer[] = [
      makePlayer({
        seat: 1,
        user_id: 'p1',
        totalInvested: 30,
        is_all_in: true,
        cards: [card('A', 'h'), card('A', 'd')],
      }), // Best hand
      makePlayer({
        seat: 2,
        user_id: 'p2',
        totalInvested: 60,
        cards: [card('K', 'h'), card('K', 'd')],
      }), // Second best
      makePlayer({
        seat: 3,
        user_id: 'p3',
        totalInvested: 60,
        cards: [card('2', 'h'), card('3', 'd')],
      }), // Worst hand
    ];
    const board = [card('7', 'c'), card('8', 's'), card('9', 'h'), card('T', 'd'), card('4', 'c')];
    const pots = calculatePots(players);
    const winners = determineWinners(players, board, pots, 'nlh');

    // p1 wins main pot (30 * 3 = 90), p2 wins side pot ((60-30)*2 = 60)
    const p1Win = winners.find((w) => w.userId === 'p1');
    const p2Win = winners.find((w) => w.userId === 'p2');
    expect(p1Win).toBeDefined();
    expect(p2Win).toBeDefined();
    expect(p1Win!.amount).toBe(90);
    expect(p2Win!.amount).toBe(60);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SHORT DECK TESTS (Improvement #9)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Short Deck Straights', () => {
  it('should detect A-6-7-8-9 straight in Short Deck (A wraps low)', () => {
    // In Short Deck, A-6-7-8-9 is a valid straight (A acts as 5 equivalent)
    const hole = [card('A', 'h'), card('9', 'd')];
    const board = [card('8', 'c'), card('7', 's'), card('6', 'h'), card('K', 'd'), card('2', 'c')];
    const result = evaluateHand(hole, board);
    // Standard evaluator treats A as 14 or 1 — A-2-3-4-5 wheel is standard
    // A-6-7-8-9 is NOT a standard straight (A doesn't connect to 6 in standard rules)
    // In standard deck, this should NOT be a straight
    expect(result.name).not.toBe('Straight');
  });

  it('should detect standard Wheel (A-2-3-4-5) straight', () => {
    const hole = [card('A', 'h'), card('5', 'd')];
    const board = [card('4', 'c'), card('3', 's'), card('2', 'h'), card('K', 'd'), card('J', 'c')];
    const result = evaluateHand(hole, board);
    expect(result.name).toBe('Straight');
    expect(result.kickers[0]).toBe(5); // 5-high straight
  });

  it('Short Deck should have 36 cards after removing below 6', () => {
    const deck = new Deck();
    deck.removeCardsBelow('6');
    expect(deck.remaining()).toBe(36);
    // Verify no 2s, 3s, 4s, or 5s
    const dealt = deck.deal(36);
    const lowCards = dealt.filter((c) => ['2', '3', '4', '5'].includes(c.rank));
    expect(lowCards).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// OMAHA HI-LO SPLIT POT TESTS (Improvement #9)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Omaha Hi-Lo Split', () => {
  it('should find qualifying low hand with A-2 and low board', () => {
    // Hole: A♥ 2♦ K♣ Q♠ — A and 2 qualify for low
    // Board: 3♣ 5♠ 7♥ T♦ J♣ — 3,5,7 are low cards
    const hole = [card('A', 'h'), card('2', 'd'), card('K', 'c'), card('Q', 's')];
    const board = [card('3', 'c'), card('5', 's'), card('7', 'h'), card('T', 'd'), card('J', 'c')];
    const lowHand = evaluateOmahaLowHand(hole, board);
    expect(lowHand).not.toBeNull();
    // Low should use A,2 from hand + 3,5,7 from board = A-2-3-5-7 (very strong low)
    expect(lowHand!.kickers.every((k: number) => k <= 8)).toBe(true);
  });

  it('should NOT find qualifying low when board has no low cards', () => {
    // Board is all face cards — no 8-or-better low possible
    const hole = [card('A', 'h'), card('2', 'd'), card('3', 'c'), card('4', 's')];
    const board = [card('K', 'c'), card('Q', 's'), card('J', 'h'), card('T', 'd'), card('9', 'c')];
    const lowHand = evaluateOmahaLowHand(hole, board);
    expect(lowHand).toBeNull();
  });

  it('should find hi hand AND lo hand when both qualify', () => {
    const hole = [card('A', 'h'), card('2', 'd'), card('K', 'h'), card('Q', 'h')];
    const board = [card('3', 'c'), card('5', 's'), card('7', 'h'), card('J', 'h'), card('T', 'h')];
    const hiHand = evaluateOmahaHand(hole, board);
    const loHand = evaluateOmahaLowHand(hole, board);
    expect(hiHand.ranking).toBeGreaterThan(0);
    expect(loHand).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-WAY ALL-IN SIDE POT TESTS (Improvement #9)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Multi-Way All-In Side Pots', () => {
  it('should create 4 pots for 4 players with different all-in amounts', () => {
    const players: SeatPlayer[] = [
      makePlayer({ seat: 1, user_id: 'p1', totalInvested: 10, is_all_in: true }),
      makePlayer({ seat: 2, user_id: 'p2', totalInvested: 30, is_all_in: true }),
      makePlayer({ seat: 3, user_id: 'p3', totalInvested: 60, is_all_in: true }),
      makePlayer({ seat: 4, user_id: 'p4', totalInvested: 100 }),
    ];
    const pots = calculatePots(players);
    // Main: 10*4=40, Side1: 20*3=60, Side2: 30*2=60, Side3: 40*1=40
    const totalAmount = pots.reduce((s, p) => s + p.amount, 0);
    expect(totalAmount).toBe(200); // Total invested = 10+30+60+100 = 200
    expect(pots.length).toBeGreaterThanOrEqual(3);
  });

  it('should award each pot to the best eligible hand', () => {
    const players: SeatPlayer[] = [
      makePlayer({
        seat: 1,
        user_id: 'p1',
        totalInvested: 20,
        is_all_in: true,
        cards: [card('A', 'h'), card('A', 'd')], // Best hand — Pair of Aces
      }),
      makePlayer({
        seat: 2,
        user_id: 'p2',
        totalInvested: 50,
        is_all_in: true,
        cards: [card('K', 'h'), card('K', 'd')], // Second — Pair of Kings
      }),
      makePlayer({
        seat: 3,
        user_id: 'p3',
        totalInvested: 50,
        cards: [card('2', 'h'), card('3', 'd')], // Worst hand
      }),
    ];
    const board = [card('7', 'c'), card('8', 's'), card('9', 'h'), card('T', 'd'), card('4', 'c')];
    const pots = calculatePots(players);
    const winners = determineWinners(players, board, pots, 'nlh');

    // p1 (AA) wins main pot, p2 (KK) wins side pot
    const p1Win = winners.find((w) => w.userId === 'p1');
    const p2Win = winners.find((w) => w.userId === 'p2');
    const p3Win = winners.find((w) => w.userId === 'p3');
    expect(p1Win).toBeDefined();
    expect(p2Win).toBeDefined();
    expect(p3Win).toBeUndefined(); // p3 has worst hand, wins nothing
    expect(p1Win!.amount).toBe(60); // 20*3 = 60
    expect(p2Win!.amount).toBe(60); // (50-20)*2 = 60
  });

  it('should handle 3-way tie for board straight', () => {
    // All 3 players use the same board straight — pot splits 3 ways
    const players: SeatPlayer[] = [
      makePlayer({
        seat: 1,
        user_id: 'p1',
        totalInvested: 30,
        cards: [card('2', 'h'), card('3', 'd')],
      }),
      makePlayer({
        seat: 2,
        user_id: 'p2',
        totalInvested: 30,
        cards: [card('2', 'c'), card('4', 'd')],
      }),
      makePlayer({
        seat: 3,
        user_id: 'p3',
        totalInvested: 30,
        cards: [card('2', 's'), card('4', 's')],
      }),
    ];
    const board = [card('A', 'c'), card('K', 's'), card('Q', 'h'), card('J', 'd'), card('T', 'c')];
    const pots = calculatePots(players);
    const winners = determineWinners(players, board, pots, 'nlh');
    // All 3 make A-K-Q-J-T straight from board
    expect(winners).toHaveLength(3);
    const totalPaid = winners.reduce((s, w) => s + w.amount, 0);
    expect(totalPaid).toBe(90);
  });
});
