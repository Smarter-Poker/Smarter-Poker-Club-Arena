/**
 * ♠ CLUB ARENA — StateVerifier Tests
 * ═══════════════════════════════════════════════════════════════════════════════
 * Tests game state integrity verification: chip conservation, negative stack
 * detection, duplicate card detection, community card count, pot sanity.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock MasterBus before importing
vi.mock('../../src/core/MasterBus', () => {
  const emitFn = vi.fn();
  return {
    masterBus: {
      emit: emitFn,
      on: vi.fn(),
      subscribe: vi.fn(),
      subscribeDebounced: vi.fn(),
    },
  };
});

import { stateVerifier } from '../../src/engine/StateVerifier';
import type { Card, SeatPlayer } from '../../src/types/database.types';
import { masterBus } from '../../src/core/MasterBus';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function makePlayers(stacks: number[]): SeatPlayer[] {
  return stacks.map((stack, i) => ({
    seat: i + 1,
    user_id: `player-${i + 1}`,
    username: `Player${i + 1}`,
    avatar_url: '',
    stack,
    bet: 0,
    totalInvested: 0,
    cards: [
      { rank: String(6 + i) as Card['rank'], suit: 'h' as Card['suit'] },
      { rank: String(7 + i) as Card['rank'], suit: 's' as Card['suit'] },
    ],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  }));
}

function makeCards(...ranks: string[]): Card[] {
  const suits: Card['suit'][] = ['h', 's', 'd', 'c'];
  return ranks.map((r, i) => ({
    rank: r as Card['rank'],
    suit: suits[i % 4],
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHIP CONSERVATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('StateVerifier - Chip Conservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset internal state by recording fresh totals
  });

  it('should pass when chip totals are conserved', () => {
    const players = makePlayers([100, 100, 100]);
    stateVerifier.recordInitialChipTotal('table-1', players);

    const result = stateVerifier.verify({
      tableId: 'table-1',
      handNumber: 1,
      players: makePlayers([80, 90, 130]), // stacks shifted but total still 300
      communityCards: makeCards('A', 'K', 'Q'),
      pot: 0,
      stage: 'flop',
    });

    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('should pass when chips are in bets (stacks + bets = initial)', () => {
    const players = makePlayers([100, 100]);
    stateVerifier.recordInitialChipTotal('table-2', players);

    // Create verify players where chips moved from stacks to bets
    const verifyPlayers = makePlayers([90, 80]);
    verifyPlayers[0].bet = 10; // 100 - 90 = 10 in bet
    verifyPlayers[1].bet = 20; // 100 - 80 = 20 in bet

    const result = stateVerifier.verify({
      tableId: 'table-2',
      handNumber: 1,
      players: verifyPlayers,
      communityCards: [],
      pot: 30, // pot is informational, not used in conservation check
      stage: 'preflop',
    });

    // Chip conservation: stacks(90+80) + bets(10+20) = 200 = initial(200)
    expect(result.valid).toBe(true);
  });

  it('should detect chip conservation violation (chips created from nothing)', () => {
    const players = makePlayers([100, 100]);
    stateVerifier.recordInitialChipTotal('table-3', players);

    const result = stateVerifier.verify({
      tableId: 'table-3',
      handNumber: 1,
      players: makePlayers([150, 100]), // 250 > initial 200
      communityCards: [],
      pot: 0,
      stage: 'preflop',
    });

    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.type === 'CHIP_CONSERVATION')).toBe(true);
  });

  it('should account for rake deduction in chip conservation', () => {
    const players = makePlayers([100, 100]);
    stateVerifier.recordInitialChipTotal('table-4', players);

    // Simulate: hand completed, 10 chips raked
    stateVerifier.deductRake('table-4', 10);

    const result = stateVerifier.verify({
      tableId: 'table-4',
      handNumber: 2,
      players: makePlayers([90, 100]), // 190 = 200 - 10 rake
      communityCards: [],
      pot: 0,
      stage: 'preflop',
    });

    expect(result.valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NEGATIVE STACK TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('StateVerifier - Negative Stack Detection', () => {
  it('should detect negative player stacks', () => {
    const players = makePlayers([100, -5]);

    const result = stateVerifier.verify({
      tableId: 'neg-test',
      handNumber: 1,
      players,
      communityCards: [],
      pot: 0,
      stage: 'preflop',
    });

    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.type === 'NEGATIVE_STACK')).toBe(true);
  });

  it('should allow zero stacks (all-in players)', () => {
    const players = makePlayers([200, 0]);

    const result = stateVerifier.verify({
      tableId: 'zero-test',
      handNumber: 1,
      players,
      communityCards: [],
      pot: 0,
      stage: 'preflop',
    });

    // Should not flag zero stacks as violations
    const negViolations = result.violations.filter((v) => v.type === 'NEGATIVE_STACK');
    expect(negViolations).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DUPLICATE CARD TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('StateVerifier - Duplicate Card Detection', () => {
  it('should detect duplicate cards across players', () => {
    const players = makePlayers([100, 100]);
    // Give both players the same card
    players[0].cards = [
      { rank: 'A', suit: 'h' },
      { rank: 'K', suit: 'h' },
    ];
    players[1].cards = [
      { rank: 'A', suit: 'h' }, // DUPLICATE
      { rank: 'Q', suit: 'h' },
    ];

    const result = stateVerifier.verify({
      tableId: 'dup-test',
      handNumber: 1,
      players,
      communityCards: [],
      pot: 0,
      stage: 'preflop',
    });

    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.type === 'DUPLICATE_CARD')).toBe(true);
  });

  it('should detect duplicates between player cards and community cards', () => {
    const players = makePlayers([100]);
    players[0].cards = [
      { rank: 'A', suit: 'h' },
      { rank: 'K', suit: 'h' },
    ];

    const result = stateVerifier.verify({
      tableId: 'dup-comm-test',
      handNumber: 1,
      players,
      communityCards: [
        { rank: 'A', suit: 'h' }, // Same as player card
        { rank: '2', suit: 'd' },
        { rank: '3', suit: 'c' },
      ],
      pot: 0,
      stage: 'flop',
    });

    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.type === 'DUPLICATE_CARD')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMMUNITY CARD COUNT TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('StateVerifier - Community Card Count', () => {
  it('should pass with 0 cards on preflop', () => {
    const result = stateVerifier.verify({
      tableId: 'cc-0',
      handNumber: 1,
      players: makePlayers([100]),
      communityCards: [],
      pot: 0,
      stage: 'preflop',
    });

    const ccViolations = result.violations.filter((v) => v.type === 'COMMUNITY_CARD_COUNT');
    expect(ccViolations).toHaveLength(0);
  });

  it('should pass with 3 cards on flop', () => {
    const result = stateVerifier.verify({
      tableId: 'cc-3',
      handNumber: 1,
      players: makePlayers([100]),
      communityCards: makeCards('A', 'K', 'Q'),
      pot: 0,
      stage: 'flop',
    });

    const ccViolations = result.violations.filter((v) => v.type === 'COMMUNITY_CARD_COUNT');
    expect(ccViolations).toHaveLength(0);
  });

  it('should detect wrong community card count for stage', () => {
    const result = stateVerifier.verify({
      tableId: 'cc-wrong',
      handNumber: 1,
      players: makePlayers([100]),
      communityCards: makeCards('A', 'K'), // Only 2 cards on flop (should be 3)
      pot: 0,
      stage: 'flop',
    });

    expect(result.violations.some((v) => v.type === 'COMMUNITY_CARD_COUNT')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUS EMISSION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('StateVerifier - Bus Emissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should emit STATE_INTEGRITY_VIOLATION on violations', () => {
    const players = makePlayers([100, -10]); // negative stack = violation

    stateVerifier.verify({
      tableId: 'bus-test',
      handNumber: 5,
      players,
      communityCards: [],
      pot: 0,
      stage: 'preflop',
    });

    expect(masterBus.emit).toHaveBeenCalledWith(
      'STATE_INTEGRITY_VIOLATION',
      expect.objectContaining({
        tableId: 'bus-test',
        handNumber: 5,
        violationCount: expect.any(Number),
      })
    );
  });

  it('should NOT emit when state is valid', () => {
    const players = makePlayers([100, 100]);
    stateVerifier.recordInitialChipTotal('no-emit-test', players);

    stateVerifier.verify({
      tableId: 'no-emit-test',
      handNumber: 1,
      players,
      communityCards: [],
      pot: 0,
      stage: 'preflop',
    });

    expect(masterBus.emit).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POT SANITY TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('StateVerifier - Pot Sanity', () => {
  it('should detect negative pot', () => {
    const result = stateVerifier.verify({
      tableId: 'neg-pot',
      handNumber: 1,
      players: makePlayers([100]),
      communityCards: [],
      pot: -5,
      stage: 'preflop',
    });

    expect(result.valid).toBe(false);
    expect(
      result.violations.some((v) => v.type === 'NEGATIVE_POT' || v.type === 'POT_SANITY')
    ).toBe(true);
  });
});
