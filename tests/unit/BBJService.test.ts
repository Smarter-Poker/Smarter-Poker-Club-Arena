/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — BBJService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests:
 * - Contribution calculation (0.5 × Big Blind)
 * - Allocation ratios (Standard 50/25/25 vs Pivot 30/40/30 at 100K threshold)
 * - BBJ trigger validation (Quad 2s minimum, variant exclusion, kicker comparison)
 * - Payout share constants (50/25/25)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

const buildChain = (): any => {
  const handler: ProxyHandler<any> = {
    get: (_target, prop) => {
      if (prop === 'maybeSingle' || prop === 'single')
        return () => Promise.resolve({ data: null, error: null });
      if (prop === 'then')
        return (resolve: (v: any) => void) => resolve({ data: null, error: null });
      return vi.fn().mockReturnValue(new Proxy({}, handler));
    },
  };
  return new Proxy({}, handler);
};

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => buildChain(),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
}));

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: (fn: () => any) => fn(),
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: (id: string) => Promise.resolve(id),
}));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: {
    getBalance: vi.fn().mockResolvedValue(0),
    logTransaction: vi.fn().mockResolvedValue(undefined),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { BBJService } from '../../src/services/BBJService';
import type { GameVariant } from '../../src/services/BBJService';

describe('BBJService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CONTRIBUTION CALCULATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('calculateContribution', () => {
    it('should return 0.5 × Big Blind', () => {
      expect(BBJService.calculateContribution(100)).toBe(50);
    });

    it('should handle small stakes', () => {
      expect(BBJService.calculateContribution(2)).toBe(1);
    });

    it('should handle large stakes', () => {
      expect(BBJService.calculateContribution(10000)).toBe(5000);
    });

    it('should handle zero big blind', () => {
      expect(BBJService.calculateContribution(0)).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ALLOCATION RATIOS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getAllocationRatios', () => {
    it('should return STANDARD ratios under 100K (50/25/25)', () => {
      const ratios = BBJService.getAllocationRatios(50000);
      expect(ratios.MAIN).toBe(0.5);
      expect(ratios.BACKUP).toBe(0.25);
      expect(ratios.PROMO).toBe(0.25);
    });

    it('should return PIVOT ratios at exactly 100K (30/40/30)', () => {
      const ratios = BBJService.getAllocationRatios(100000);
      expect(ratios.MAIN).toBe(0.3);
      expect(ratios.BACKUP).toBe(0.4);
      expect(ratios.PROMO).toBe(0.3);
    });

    it('should return PIVOT ratios above 100K', () => {
      const ratios = BBJService.getAllocationRatios(500000);
      expect(ratios.MAIN).toBe(0.3);
    });

    it('should return STANDARD ratios at 0', () => {
      const ratios = BBJService.getAllocationRatios(0);
      expect(ratios.MAIN).toBe(0.5);
    });

    it('should return STANDARD ratios at 99999', () => {
      const ratios = BBJService.getAllocationRatios(99999);
      expect(ratios.MAIN).toBe(0.5);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BBJ TRIGGER VALIDATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('checkBBJTrigger', () => {
    const makeHand = (ranking: number, name: string, kickers: number[] = []) => ({
      ranking,
      name,
      kickers,
      cards: [],
      description: name,
    });

    it('should NOT trigger for PLO6 variant', () => {
      const result = BBJService.checkBBJTrigger(
        makeHand(8, 'Four of a Kind - Aces') as any,
        makeHand(9, 'Straight Flush') as any,
        'plo6' as GameVariant
      );
      expect(result.triggered).toBe(false);
      expect(result.reason).toContain('PLO6');
    });

    it('should NOT trigger for OFC variant', () => {
      const result = BBJService.checkBBJTrigger(
        makeHand(8, 'Four of a Kind') as any,
        makeHand(9, 'Straight Flush') as any,
        'ofc' as GameVariant
      );
      expect(result.triggered).toBe(false);
      expect(result.reason).toContain('OFC');
    });

    it('should NOT trigger when losing hand is below Quad 2s (ranking < 8)', () => {
      const result = BBJService.checkBBJTrigger(
        makeHand(7, 'Full House') as any,
        makeHand(8, 'Four of a Kind') as any,
        'nlh' as GameVariant
      );
      expect(result.triggered).toBe(false);
      expect(result.reason).toContain('Quad 2s or better');
    });

    it('should trigger when losing hand is Quads beaten by higher hand', () => {
      const result = BBJService.checkBBJTrigger(
        makeHand(8, 'Four of a Kind - Kings', [13, 13, 13, 13, 5]) as any,
        makeHand(9, 'Straight Flush', [14]) as any,
        'nlh' as GameVariant
      );
      expect(result.triggered).toBe(true);
      expect(result.losingHand).toBe('Four of a Kind - Kings');
      expect(result.winningHand).toBe('Straight Flush');
    });

    it('should NOT trigger when winning hand does not beat losing hand', () => {
      const result = BBJService.checkBBJTrigger(
        makeHand(8, 'Four of a Kind - Aces', [14, 14, 14, 14, 5]) as any,
        makeHand(7, 'Full House', [13, 13, 13, 10, 10]) as any,
        'nlh' as GameVariant
      );
      expect(result.triggered).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // KICKER COMPARISON
  // ─────────────────────────────────────────────────────────────────────────

  describe('compareKickers', () => {
    it('should return positive when first kicker set is higher', () => {
      expect(BBJService.compareKickers([14, 10], [14, 8])).toBeGreaterThan(0);
    });

    it('should return negative when first is lower', () => {
      expect(BBJService.compareKickers([12, 10], [14, 8])).toBeLessThan(0);
    });

    it('should return 0 for equal kickers', () => {
      expect(BBJService.compareKickers([14, 10], [14, 10])).toBe(0);
    });

    it('should return positive for longer array when equal prefix', () => {
      expect(BBJService.compareKickers([14, 10, 5], [14, 10])).toBeGreaterThan(0);
    });
  });
});
