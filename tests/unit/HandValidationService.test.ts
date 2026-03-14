/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — HandValidationService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests client-side hand result verification:
 * - Pot mismatch detection (bets vs pots)
 * - Amount mismatch detection (winnings vs pots)
 * - Folded winner detection
 * - Side pot eligibility validation
 * - Over-winning detection
 * - Clean hand validation (no discrepancies)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      insert: () => Promise.resolve({ error: null }),
    }),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { HandValidationService } from '../../src/services/HandValidationService';
import type { HandValidationInput } from '../../src/services/HandValidationService';

describe('HandValidationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Helper: Create valid hand input ────────────────────────────────────
  const makeValidHand = (): HandValidationInput => ({
    handId: 'hand-1',
    tableId: 'table-1',
    communityCards: ['As', 'Ks', 'Qs', 'Js', 'Ts'],
    players: [
      { id: 'p1', holeCards: ['Ah', 'Kh'], betTotal: 100, isAllIn: false, isFolded: false },
      { id: 'p2', holeCards: ['2c', '3c'], betTotal: 100, isAllIn: false, isFolded: true },
    ],
    pots: [{ amount: 200, eligiblePlayerIds: ['p1', 'p2'], winnerId: 'p1' }],
    reportedWinners: [{ playerId: 'p1', amount: 200 }],
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CLEAN VALIDATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('valid hands', () => {
    it('should return valid=true for a correct hand', () => {
      const result = HandValidationService.validate(makeValidHand());
      expect(result.valid).toBe(true);
      expect(result.discrepancies).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POT MISMATCH
  // ─────────────────────────────────────────────────────────────────────────

  describe('pot mismatch detection', () => {
    it('should detect when total bets ≠ total pots', () => {
      const hand = makeValidHand();
      // Players bet 200 total but pot says 180
      hand.pots = [{ amount: 180, eligiblePlayerIds: ['p1', 'p2'], winnerId: 'p1' }];
      hand.reportedWinners = [{ playerId: 'p1', amount: 180 }];

      const result = HandValidationService.validate(hand);
      expect(result.valid).toBe(false);
      expect(result.discrepancies.some((d) => d.type === 'POT_MISMATCH')).toBe(true);
    });

    it('should tolerate rounding errors within 0.01', () => {
      const hand = makeValidHand();
      // 0.005 difference should be OK
      hand.pots = [{ amount: 199.995, eligiblePlayerIds: ['p1', 'p2'], winnerId: 'p1' }];
      hand.reportedWinners = [{ playerId: 'p1', amount: 199.995 }];

      const result = HandValidationService.validate(hand);
      // 200 - 199.995 = 0.005 < 0.01 threshold
      expect(result.discrepancies.filter((d) => d.type === 'POT_MISMATCH')).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AMOUNT MISMATCH
  // ─────────────────────────────────────────────────────────────────────────

  describe('amount mismatch detection', () => {
    it('should detect when total winnings ≠ total pots', () => {
      const hand = makeValidHand();
      // Winner claims 250 from a 200 pot
      hand.reportedWinners = [{ playerId: 'p1', amount: 250 }];

      const result = HandValidationService.validate(hand);
      expect(result.valid).toBe(false);
      expect(result.discrepancies.some((d) => d.type === 'AMOUNT_MISMATCH')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FOLDED WINNER
  // ─────────────────────────────────────────────────────────────────────────

  describe('folded winner detection', () => {
    it('should flag a folded player winning a pot', () => {
      const hand = makeValidHand();
      // P2 wins but is folded
      hand.pots = [{ amount: 200, eligiblePlayerIds: ['p1', 'p2'], winnerId: 'p2' }];
      hand.reportedWinners = [{ playerId: 'p2', amount: 200 }];

      const result = HandValidationService.validate(hand);
      expect(result.valid).toBe(false);
      expect(result.discrepancies.some((d) => d.type === 'WINNER_MISMATCH')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SIDE POT ELIGIBILITY
  // ─────────────────────────────────────────────────────────────────────────

  describe('side pot eligibility', () => {
    it('should flag a winner not in the eligible player list', () => {
      const hand = makeValidHand();
      // P1 wins but is not in the eligible list
      hand.pots = [{ amount: 200, eligiblePlayerIds: ['p2'], winnerId: 'p1' }];

      const result = HandValidationService.validate(hand);
      expect(result.valid).toBe(false);
      expect(result.discrepancies.some((d) => d.type === 'SIDE_POT_ERROR')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // OVER-WINNING
  // ─────────────────────────────────────────────────────────────────────────

  describe('over-winning detection', () => {
    it('should flag a player winning more than total pots', () => {
      const hand = makeValidHand();
      hand.reportedWinners = [{ playerId: 'p1', amount: 500 }]; // More than 200 pot

      const result = HandValidationService.validate(hand);
      expect(result.valid).toBe(false);
      expect(
        result.discrepancies.some((d) => d.type === 'AMOUNT_MISMATCH' && d.actual.includes('500'))
      ).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MULTI-POT / SPLIT POT
  // ─────────────────────────────────────────────────────────────────────────

  describe('multi-pot validation', () => {
    it('should validate correctly with multiple pots', () => {
      const hand: HandValidationInput = {
        handId: 'hand-2',
        tableId: 'table-1',
        communityCards: ['As', 'Ks', 'Qs', 'Js', 'Ts'],
        players: [
          { id: 'p1', holeCards: ['Ah', 'Kh'], betTotal: 150, isAllIn: true, isFolded: false },
          { id: 'p2', holeCards: ['2c', '3c'], betTotal: 150, isAllIn: false, isFolded: false },
          { id: 'p3', holeCards: ['4c', '5c'], betTotal: 100, isAllIn: true, isFolded: false },
        ],
        pots: [
          { amount: 300, eligiblePlayerIds: ['p1', 'p2', 'p3'], winnerId: 'p1' },
          { amount: 100, eligiblePlayerIds: ['p1', 'p2'], winnerId: 'p2' },
        ],
        reportedWinners: [
          { playerId: 'p1', amount: 300 },
          { playerId: 'p2', amount: 100 },
        ],
      };

      const result = HandValidationService.validate(hand);
      expect(result.valid).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SEVERITY
  // ─────────────────────────────────────────────────────────────────────────

  describe('severity classification', () => {
    it('should mark pot mismatches as critical', () => {
      const hand = makeValidHand();
      hand.pots = [{ amount: 100, eligiblePlayerIds: ['p1', 'p2'], winnerId: 'p1' }];
      hand.reportedWinners = [{ playerId: 'p1', amount: 100 }];

      const result = HandValidationService.validate(hand);
      const potMismatch = result.discrepancies.find((d) => d.type === 'POT_MISMATCH');
      expect(potMismatch?.severity).toBe('critical');
    });
  });
});
