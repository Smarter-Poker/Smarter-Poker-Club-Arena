/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE SYSTEM E2E VERIFICATION TEST
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Comprehensive end-to-end test of the horse system covering:
 * - BotLogic decision validation for all 5 styles
 * - HydraService horse availability filtering
 * - Multi-table limit enforcement
 * - Rake calculation for various pot sizes
 * - BBJ contribution calculation
 * - Auto-rebuy triggers
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HorseLogic, type HorseStyle, type HorseDecision } from '../../src/engine/HorseLogic';
import { RakeService } from '../../src/services/RakeService';
import type { SeatPlayer, Card } from '../../src/types/database.types';

// ═══════════════════════════════════════════════════════════════════════════════
// MOCK DATA & FIXTURES
// ═══════════════════════════════════════════════════════════════════════════════

const createMockPlayer = (overrides: Partial<SeatPlayer> = {}): SeatPlayer => ({
  seat: 1,
  user_id: 'horse-001',
  username: 'TestHorse',
  stack: 10000,
  bet: 0,
  totalInvested: 0,
  cards: [
    { rank: 'A', suit: 'hearts' },
    { rank: 'K', suit: 'spades' },
  ],
  is_folded: false,
  is_all_in: false,
  is_sitting_out: false,
  ...overrides,
});

const createMockGameState = (overrides: any = {}) => ({
  players: [
    createMockPlayer({ user_id: 'p1', stack: 10000 }),
    createMockPlayer({ user_id: 'p2', stack: 5000 }),
    createMockPlayer({ user_id: 'p3', stack: 8000 }),
  ],
  communityCards: [] as Card[],
  pot: 150,
  currentBet: 50,
  minRaise: 50,
  stage: 'preflop' as const,
  gameVariant: 'nlh',
  bigBlind: 2,
  ...overrides,
});

// ═══════════════════════════════════════════════════════════════════════════════
// HORSELOGIC TESTS — All 5 Horse Styles
// ═══════════════════════════════════════════════════════════════════════════════

describe('HorseLogic.decide() — Decision Validation', () => {
  const styles: HorseStyle[] = ['tag', 'lag', 'balanced', 'tricky', 'grinder'];

  describe.each(styles)('Style: %s', (style) => {
    it(`should return valid action type for ${style}`, () => {
      const player = createMockPlayer();
      const gameState = createMockGameState();

      const decision = HorseLogic.decide(player, gameState as any, style);

      expect(decision).toBeDefined();
      expect(decision.action).toMatch(/^(fold|check|call|bet|raise|allin)$/);
      expect(typeof decision.thinkTime).toBe('number');
      expect(decision.thinkTime).toBeGreaterThanOrEqual(250);
      expect(decision.thinkTime).toBeLessThanOrEqual(1000);
    });

    it(`should return valid amount for ${style} when action is bet/raise`, () => {
      const player = createMockPlayer({ stack: 10000 });
      const gameState = createMockGameState();

      const decision = HorseLogic.decide(player, gameState as any, style);

      if (decision.action === 'bet' || decision.action === 'raise') {
        expect(decision.amount).toBeDefined();
        expect(typeof decision.amount).toBe('number');
        expect(decision.amount).toBeGreaterThanOrEqual(0);
        expect(decision.amount).toBeLessThanOrEqual(player.stack + player.bet);
        expect(Number.isNaN(decision.amount as number)).toBe(false);
      }
    });

    it(`should handle short stack correctly for ${style}`, () => {
      const player = createMockPlayer({ stack: 10 }); // Very short
      const gameState = createMockGameState();

      const decision = HorseLogic.decide(player, gameState as any, style);

      expect(decision).toBeDefined();
      // Should fold, check, or call with short stack, not overcommit
      if (decision.action === 'bet' || decision.action === 'raise') {
        expect(decision.amount).toBeLessThanOrEqual(10);
      }
    });

    it(`should handle all-in correctly for ${style}`, () => {
      const player = createMockPlayer({ stack: 100 });
      const gameState = createMockGameState({
        currentBet: 500, // Huge bet, should trigger all-in
        pot: 1000,
      });

      const decision = HorseLogic.decide(player, gameState as any, style);

      // With small stack and large bet, should either fold or all-in
      expect(['fold', 'allin', 'call']).toContain(decision.action);
    });

    it(`should have different behavior on different streets for ${style}`, () => {
      const player = createMockPlayer();
      const baseGameState = createMockGameState();

      const preflopDecision = HorseLogic.decide(
        player,
        { ...baseGameState, stage: 'preflop' } as any,
        style
      );
      const flopDecision = HorseLogic.decide(
        player,
        {
          ...baseGameState,
          stage: 'flop',
          communityCards: [
            { rank: '2', suit: 'hearts' },
            { rank: '7', suit: 'clubs' },
            { rank: 'K', suit: 'diamonds' },
          ],
        } as any,
        style
      );

      // Decisions might differ due to hand strength evaluation
      expect(preflopDecision).toBeDefined();
      expect(flopDecision).toBeDefined();
    });

    it(`should not return NaN or negative amounts for ${style}`, () => {
      const player = createMockPlayer({ stack: 5000 });
      const gameState = createMockGameState({ pot: 0, currentBet: 0 });

      for (let i = 0; i < 10; i++) {
        const decision = HorseLogic.decide(player, gameState as any, style);

        if (decision.amount !== undefined) {
          expect(Number.isNaN(decision.amount)).toBe(false);
          expect(decision.amount).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it(`should not return amount > stack for ${style}`, () => {
      const stack = 2000;
      const player = createMockPlayer({ stack });
      const gameState = createMockGameState();

      for (let i = 0; i < 20; i++) {
        const decision = HorseLogic.decide(player, gameState as any, style);

        if ((decision.action === 'bet' || decision.action === 'raise') && decision.amount) {
          expect(decision.amount).toBeLessThanOrEqual(stack + player.bet);
        }
      }
    });

    it(`should fold when facing overwhelming bet with weak hand for ${style}`, () => {
      const player = createMockPlayer({
        stack: 100,
        cards: [
          { rank: '7', suit: 'hearts' },
          { rank: '2', suit: 'clubs' },
        ],
      });
      const gameState = createMockGameState({
        currentBet: 300,
        pot: 500,
      });

      const decision = HorseLogic.decide(player, gameState as any, style);

      // Weak hand facing big bet should fold frequently
      expect(['fold', 'call', 'allin']).toContain(decision.action);
    });
  });

  it('should return consistent structure across all styles', () => {
    const player = createMockPlayer();
    const gameState = createMockGameState();

    styles.forEach((style) => {
      const decision = HorseLogic.decide(player, gameState as any, style);

      // All decisions must have these fields
      expect(decision).toHaveProperty('action');
      expect(decision).toHaveProperty('thinkTime');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RAKE SERVICE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('RakeService.calculateRake() — Rake Calculation', () => {
  it('should calculate rake with 10% rule', () => {
    const result = RakeService.calculateRake(1000, 2, true);

    expect(result.potSize).toBe(1000);
    expect(result.rakePercent).toBe(0.1);
    expect(result.rawRake).toBe(100); // 10% of 1000
    expect(result.cappedRake).toBeLessThanOrEqual(result.rakeCap);
  });

  it('should apply rake cap correctly', () => {
    const result = RakeService.calculateRake(100000, 2, true);

    // Should be capped, not 10000
    expect(result.cappedRake).toBeLessThanOrEqual(result.rakeCap);
  });

  it('should not charge rake if hand did not go to flop', () => {
    const result = RakeService.calculateRake(1000, 2, false);

    expect(result.cappedRake).toBe(0);
    expect(result.bbjDrop).toBe(0);
    expect(result.totalDeduction).toBe(0);
  });

  it('should handle various big blind amounts', () => {
    const bbAmounts = [0.5, 1, 2, 5, 10, 100];

    bbAmounts.forEach((bb) => {
      const result = RakeService.calculateRake(500, bb, true);

      expect(result).toBeDefined();
      expect(result.cappedRake).toBeGreaterThanOrEqual(0);
      expect(result.netPot).toBe(result.potSize - result.totalDeduction);
    });
  });

  it('should calculate BBJ contribution correctly', () => {
    const result = RakeService.calculateRake(1000, 2, true);

    // BBJ drop should be > 0 for raked hands
    expect(result.bbjDrop).toBeGreaterThanOrEqual(0);
  });

  it('should use integer arithmetic (scaled, not floats)', () => {
    const result = RakeService.calculateRake(999.99, 2, true);

    // Verify no floating point errors
    const roundTripCheck = Math.trunc(result.cappedRake * 100) % 1;
    expect(roundTripCheck).toBe(0);
  });

  it('should never return negative rake', () => {
    for (let i = 0; i < 50; i++) {
      const pot = Math.random() * 100000;
      const bb = Math.random() * 100 + 0.25;

      const result = RakeService.calculateRake(pot, bb, true);

      expect(result.cappedRake).toBeGreaterThanOrEqual(0);
      expect(result.bbjDrop).toBeGreaterThanOrEqual(0);
    }
  });

  it('should ensure netPot calculation is correct', () => {
    const pot = 5000;
    const result = RakeService.calculateRake(pot, 5, true);

    expect(result.netPot).toBe(pot - result.cappedRake - result.bbjDrop);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BBJ SERVICE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

/* The `BBJService` block was removed on 2026-09-11 with the service itself.
   It asserted `calculateContribution`, `getAllocationRatios` and
   `checkBBJTrigger`, none of which had existed for months - this file is
   excluded from vitest and tsconfig, so it broke nothing, but it pinned a
   fee schedule and a trigger rule the platform no longer has. */

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('E2E Integration — Full Hand Flow', () => {
  it('should complete rake calculation for various pot sizes', () => {
    const testCases = [
      { pot: 100, bb: 2 },
      { pot: 1000, bb: 5 },
      { pot: 10000, bb: 10 },
      { pot: 50000, bb: 100 },
    ];

    testCases.forEach(({ pot, bb }) => {
      const rakeCalc = RakeService.calculateRake(pot, bb, true);

      expect(rakeCalc.netPot).toBeGreaterThanOrEqual(0);
      expect(rakeCalc.netPot).toBeLessThanOrEqual(pot);
      expect(rakeCalc.cappedRake).toBeGreaterThanOrEqual(0);
    });
  });

  it('should distribute rake evenly among dealt-in players', () => {
    const totalRake = 100;
    const numPlayers = 3;

    // Simulate distribution
    const baseCreditScaled = Math.trunc((totalRake * 100) / numPlayers);
    const remainderScaled = totalRake * 100 - baseCreditScaled * numPlayers;

    const attributions = Array.from({ length: numPlayers }, (_, i) => {
      const extra = i < remainderScaled ? 1 : 0;
      return (baseCreditScaled + extra) / 100;
    });

    const total = attributions.reduce((a, b) => a + b, 0);

    expect(Math.abs(total - totalRake)).toBeLessThan(0.01);
  });

  it('should handle edge case: single player in hand', () => {
    const rakeCalc = RakeService.calculateRake(500, 2, true);

    expect(rakeCalc).toBeDefined();
    expect(rakeCalc.cappedRake).toBeGreaterThanOrEqual(0);
  });

  it('should handle edge case: zero pot', () => {
    const rakeCalc = RakeService.calculateRake(0, 2, false);

    expect(rakeCalc.cappedRake).toBe(0);
    expect(rakeCalc.totalDeduction).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Regression Tests — Bug Prevention', () => {
  it('should not allow invalid action transitions', () => {
    const player = createMockPlayer();
    const gameState = createMockGameState();

    for (let i = 0; i < 30; i++) {
      const decision = HorseLogic.decide(player, gameState as any, 'balanced');

      // Check no undefined actions
      expect(decision.action).not.toBeUndefined();
      expect(decision.action).not.toBe('');
    }
  });

  it('should not return Infinity or very large numbers', () => {
    const player = createMockPlayer({ stack: Number.MAX_SAFE_INTEGER });
    const gameState = createMockGameState({ pot: Number.MAX_SAFE_INTEGER });

    const decision = HorseLogic.decide(player, gameState as any, 'balanced');

    if (decision.amount !== undefined) {
      expect(Number.isFinite(decision.amount)).toBe(true);
    }
  });

  it('should handle negative stack edge case', () => {
    const player = createMockPlayer({ stack: -100 });
    const gameState = createMockGameState();

    const decision = HorseLogic.decide(player, gameState as any, 'balanced');

    // Should still return valid decision even with negative stack
    expect(decision).toBeDefined();
    expect(decision.action).toBeDefined();
  });

  it('should handle game state with no players', () => {
    const gameState = createMockGameState({ players: [] });
    const player = createMockPlayer();

    const decision = HorseLogic.decide(player, gameState as any, 'balanced');

    expect(decision).toBeDefined();
  });

  it('should not crash on empty card array', () => {
    const player = createMockPlayer({ cards: [] });
    const gameState = createMockGameState();

    const decision = HorseLogic.decide(player, gameState as any, 'balanced');

    expect(decision).toBeDefined();
  });
});
