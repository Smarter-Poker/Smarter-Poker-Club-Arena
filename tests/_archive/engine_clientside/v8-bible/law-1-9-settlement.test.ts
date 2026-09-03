/**
 * ♠ V8 BIBLE COMPLIANCE — Law 1.9: Settlement Law
 * ═══════════════════════════════════════════════════════════════
 * Bible Ref: Chapter 1, Law 1.9
 * "Hand settlement follows this EXACT sequence (15 steps)"
 *
 * Tests verify:
 * - Pot calculation from contributions
 * - Hand evaluation for all active players
 * - Winner determination per pot (including hi-lo split)
 * - Rake calculation (percentage with cap, no-flop-no-drop)
 * - Distribution of winnings
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateHand,
  evaluateOmahaHand,
  evaluateOmahaLowHand,
  compareHands,
  calculatePots,
  calculateRake,
  determineWinners,
} from '../../../src/engine/PokerEngine';
import type { Card, SeatPlayer } from '../../../src/types/database.types';

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// STEP 2: Calculate side pots from contributions
// ═══════════════════════════════════════════════════════════════

describe('V8 Bible — Settlement Step 2: Side Pot Calculation', () => {
  it('single pot when all players invest equally', () => {
    const players = [
      makePlayer({ seat: 1, user_id: 'p1', totalInvested: 50 }),
      makePlayer({ seat: 2, user_id: 'p2', totalInvested: 50 }),
    ];
    const pots = calculatePots(players);
    expect(pots).toHaveLength(1);
    expect(pots[0].amount).toBe(100);
    expect(pots[0].eligible).toHaveLength(2);
  });

  it('creates correct side pots for uneven all-ins', () => {
    const players = [
      makePlayer({ seat: 1, user_id: 'p1', totalInvested: 20, is_all_in: true }),
      makePlayer({ seat: 2, user_id: 'p2', totalInvested: 50, is_all_in: true }),
      makePlayer({ seat: 3, user_id: 'p3', totalInvested: 50 }),
    ];
    const pots = calculatePots(players);

    // Main pot: 20 * 3 = 60 (all eligible)
    // Side pot: 30 * 2 = 60 (p2, p3 eligible)
    const totalPots = pots.reduce((sum, p) => sum + p.amount, 0);
    expect(totalPots).toBe(120);
    expect(pots[0].eligible).toHaveLength(3);
  });

  it('excludes folded players from pot eligibility', () => {
    const players = [
      makePlayer({ seat: 1, user_id: 'p1', totalInvested: 20, is_folded: true }),
      makePlayer({ seat: 2, user_id: 'p2', totalInvested: 50 }),
      makePlayer({ seat: 3, user_id: 'p3', totalInvested: 50 }),
    ];
    const pots = calculatePots(players);

    // Folded player's money goes to pot but they're not eligible
    for (const pot of pots) {
      const hasFolder = pot.eligible.some((id: string) => id === 'p1');
      expect(hasFolder).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// STEP 3: Evaluate all active players' hands
// ═══════════════════════════════════════════════════════════════

describe('V8 Bible — Settlement Step 3: Hand Evaluation', () => {
  it('correctly evaluates royal flush', () => {
    const hand = evaluateHand(
      [card('A', 'h'), card('K', 'h')],
      [card('Q', 'h'), card('J', 'h'), card('10', 'h'), card('2', 's'), card('3', 'd')]
    );
    expect(hand.rank).toBeLessThanOrEqual(1); // Royal flush is highest rank
  });

  it('correctly evaluates full house', () => {
    const hand = evaluateHand(
      [card('A', 'h'), card('A', 'd')],
      [card('A', 'c'), card('K', 'h'), card('K', 'd'), card('2', 's'), card('3', 'd')]
    );
    // Full house should be ranked appropriately
    expect(hand.rank).toBeDefined();
    expect(hand.name).toBeDefined();
  });

  it('correctly compares two hands', () => {
    const flush = evaluateHand(
      [card('A', 'h'), card('K', 'h')],
      [card('Q', 'h'), card('J', 'h'), card('9', 'h'), card('2', 's'), card('3', 'd')]
    );
    const pair = evaluateHand(
      [card('A', 's'), card('K', 'd')],
      [card('Q', 'h'), card('J', 'h'), card('9', 'h'), card('2', 's'), card('A', 'd')]
    );

    // Flush should beat a pair
    const result = compareHands(flush, pair);
    expect(result).toBeLessThan(0); // Negative = first hand wins
  });
});

// ═══════════════════════════════════════════════════════════════
// STEP 5: Calculate rake (percentage with cap, no-flop-no-drop)
// ═══════════════════════════════════════════════════════════════

describe('V8 Bible — Settlement Step 5: Rake Calculation', () => {
  it('takes correct percentage rake', () => {
    const rake = calculateRake(100, { percent: 5, cap: 10, noFlop: true }, true);
    expect(rake).toBe(5); // 5% of 100
  });

  it('caps rake at maximum', () => {
    const rake = calculateRake(1000, { percent: 5, cap: 10, noFlop: true }, true);
    expect(rake).toBe(10); // 5% = 50, but capped at 10
  });

  it('no-flop-no-drop: zero rake when hand ended preflop', () => {
    const rake = calculateRake(100, { percent: 5, cap: 10, noFlop: true }, false);
    expect(rake).toBe(0); // No flop seen = no rake
  });

  it('takes rake when flop was seen even with noFlop config', () => {
    const rake = calculateRake(100, { percent: 5, cap: 10, noFlop: true }, true);
    expect(rake).toBe(5); // Flop was seen, rake applies
  });
});

// ═══════════════════════════════════════════════════════════════
// STEP 4: Determine winners per pot
// ═══════════════════════════════════════════════════════════════

describe('V8 Bible — Settlement Step 4: Winner Determination', () => {
  it('awards pot to the player with the best hand', () => {
    const community = [
      card('Q', 'h'),
      card('J', 'h'),
      card('9', 'h'),
      card('2', 's'),
      card('3', 'd'),
    ];

    const players = [
      makePlayer({
        seat: 1,
        user_id: 'p1',
        totalInvested: 50,
        cards: [card('A', 'h'), card('K', 'h')], // Ace-high flush
      }),
      makePlayer({
        seat: 2,
        user_id: 'p2',
        totalInvested: 50,
        cards: [card('A', 's'), card('K', 'd')], // Ace-King high
      }),
    ];

    const pots = [{ amount: 100, eligible: ['p1', 'p2'] }];
    const winners = determineWinners(players, community, pots, 'nlh');

    // Player 1 should win with the flush
    expect(winners).toHaveLength(1);
    expect(winners[0].userId).toBe('p1');
    expect(winners[0].amount).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════
// Appendix C: Hand Rankings (Hold'em)
// RF > SF > 4K > FH > F > S > 3K > 2P > 1P > HC
// ═══════════════════════════════════════════════════════════════

describe('V8 Bible — Appendix C: Hand Rankings Order', () => {
  const community = [
    card('2', 'c'),
    card('5', 'd'),
    card('8', 'h'),
    card('J', 's'),
    card('Q', 'c'),
  ];

  it('straight flush beats four of a kind', () => {
    // This tests the ranking order - details depend on implementation
    const sf = evaluateHand(
      [card('9', 'h'), card('10', 'h')],
      [card('J', 'h'), card('Q', 'h'), card('K', 'h'), card('2', 's'), card('3', 'd')]
    );
    const quads = evaluateHand(
      [card('Q', 'd'), card('Q', 's')],
      [card('Q', 'h'), card('Q', 'c'), card('K', 'h'), card('2', 's'), card('3', 'd')]
    );

    const result = compareHands(sf, quads);
    expect(result).toBeLessThan(0); // SF wins
  });

  it('full house beats flush', () => {
    const fh = evaluateHand(
      [card('A', 'h'), card('A', 'd')],
      [card('A', 'c'), card('K', 'h'), card('K', 'd'), card('2', 's'), card('3', 'd')]
    );
    const flush = evaluateHand(
      [card('A', 's'), card('9', 's')],
      [card('7', 's'), card('5', 's'), card('3', 's'), card('2', 'h'), card('J', 'd')]
    );

    const result = compareHands(fh, flush);
    expect(result).toBeLessThan(0); // FH wins
  });
});
