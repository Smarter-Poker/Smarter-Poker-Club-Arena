/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — RakeService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests the Rake Waterfall Engine — financial law enforcement:
 * - 10% Rake Law (flat 10% of pot)
 * - Rake Cap Law (stake-tier dependent cap)
 * - No Flop, No Drop rule
 * - BBJ Drop calculation (stake-tier dependent)
 * - Tournament rake (flat 10% of buy-in)
 * - Integer arithmetic (×100) precision
 * - Tier lookup (exact match + closest match fallback)
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

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: (fn: () => any) => fn(),
}));

vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: (id: string) => Promise.resolve(id),
}));

vi.mock('../../src/services/BBJService', () => ({
  BBJService: {
    getPool: vi.fn().mockResolvedValue(null),
    ensurePoolExists: vi.fn().mockResolvedValue(null),
    recordContribution: vi.fn().mockResolvedValue(null),
  },
}));

// NOTE (2026-04-23, Phase U2): the previous `vi.mock('../../src/engine/RakebackEngine', ...)`
// here is removed because src/engine/RakebackEngine no longer exists — rakeback logic is
// now server-authoritative (Hetzner). RakeService itself is pure math and no longer
// imports from src/engine/.

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { RakeService } from '../../src/services/RakeService';

describe('RakeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RAKE CALCULATION — 10% LAW
  // ─────────────────────────────────────────────────────────────────────────

  describe('calculateRake — 10% Law', () => {
    it('should take 10% of pot at 1/2 stakes (BB=2)', () => {
      const result = RakeService.calculateRake(100, 2, true, 1);
      expect(result.rakePercent).toBe(0.1); // 10% flat
      expect(result.rawRake).toBe(10); // 10% of 100
    });

    it('should take 10% of pot at 0.5/1 stakes (BB=1)', () => {
      const result = RakeService.calculateRake(50, 1, true, 0.5);
      expect(result.rawRake).toBe(5); // 10% of 50
    });

    it('should cap rake at the tier maxAmount', () => {
      // 1/2 tier: maxAmount = 5
      const result = RakeService.calculateRake(200, 2, true, 1);
      expect(result.rawRake).toBe(20); // 10% of 200
      expect(result.cappedRake).toBe(5); // Capped at 5
      expect(result.rakeCap).toBe(5);
    });

    it('should not cap when raw rake is under cap', () => {
      // 1/2 tier: maxAmount = 5, pot=40 → raw=4
      const result = RakeService.calculateRake(40, 2, true, 1);
      expect(result.rawRake).toBe(4);
      expect(result.cappedRake).toBe(4); // Under cap, no truncation
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // NO FLOP, NO DROP
  // ─────────────────────────────────────────────────────────────────────────

  describe('No Flop, No Drop rule', () => {
    it('should return zero rake when hand did not go to flop', () => {
      const result = RakeService.calculateRake(500, 2, false, 1);
      expect(result.rawRake).toBe(0);
      expect(result.cappedRake).toBe(0);
      expect(result.bbjDrop).toBe(0);
      expect(result.totalDeduction).toBe(0);
      expect(result.netPot).toBe(500);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BBJ DROP
  // ─────────────────────────────────────────────────────────────────────────

  describe('BBJ Drop calculation', () => {
    it('should calculate BBJ drop based on tier bbjRakeBB', () => {
      // 0.5/1 tier: bbjRakeBB = 0.25, BB=1 → BBJ = 0.25 × 1 = 0.25
      const result = RakeService.calculateRake(100, 1, true, 0.5);
      expect(result.bbjDrop).toBe(0.25);
    });

    it('should include BBJ in total deduction', () => {
      const result = RakeService.calculateRake(100, 1, true, 0.5);
      expect(result.totalDeduction).toBe(result.cappedRake + result.bbjDrop);
    });

    it('should calculate net pot correctly', () => {
      const result = RakeService.calculateRake(100, 1, true, 0.5);
      expect(result.netPot).toBe(100 - result.totalDeduction);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TIER LOOKUP
  // ─────────────────────────────────────────────────────────────────────────

  describe('getTier', () => {
    it('should find exact match for 1/2 stakes', () => {
      const tier = RakeService.getTier(1, 2);
      expect(tier.sb).toBe(1);
      expect(tier.bb).toBe(2);
      expect(tier.maxAmount).toBe(5);
    });

    it('should find exact match for 5/10 stakes', () => {
      const tier = RakeService.getTier(5, 10);
      expect(tier.maxAmount).toBe(12.5);
    });

    it('should fallback to closest BB match for non-chart stakes', () => {
      // BB=3 is not in chart — closest is BB=2 or BB=4
      const tier = RakeService.getTier(1.5, 3);
      expect(tier.bb).toBe(2); // Closest by BB
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BBJ SPLIT
  // ─────────────────────────────────────────────────────────────────────────

  describe('getBBJSplit', () => {
    it('should return main/backup/promo split for given stakes', () => {
      const split = RakeService.getBBJSplit(1, 2);
      expect(split.main).toBe(0.4);
      expect(split.backup).toBe(0.3);
      expect(split.promo).toBe(0.3);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TOURNAMENT RAKE
  // ─────────────────────────────────────────────────────────────────────────

  describe('calculateTournamentRake', () => {
    it('should take 10% of buy-in as rake', () => {
      const result = RakeService.calculateTournamentRake(100);
      expect(result.rake).toBe(10);
      expect(result.prizePoolContribution).toBe(90);
    });

    it('should handle large buy-ins', () => {
      const result = RakeService.calculateTournamentRake(10000);
      expect(result.rake).toBe(1000);
      expect(result.prizePoolContribution).toBe(9000);
    });

    it('should handle zero buy-in', () => {
      const result = RakeService.calculateTournamentRake(0);
      expect(result.rake).toBe(0);
      expect(result.prizePoolContribution).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SCALING MATRIX
  // ─────────────────────────────────────────────────────────────────────────

  describe('getScalingMatrix', () => {
    it('should return 14 tiers', () => {
      const matrix = RakeService.getScalingMatrix();
      expect(matrix).toHaveLength(14);
    });

    it('should have increasing big blinds', () => {
      const matrix = RakeService.getScalingMatrix();
      // First tier BB should be smallest
      expect(matrix[0].bigBlind).toBe(0.2);
      // Last tier BB should be largest
      expect(matrix[matrix.length - 1].bigBlind).toBe(25);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // LAWS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getLaws', () => {
    it('should return immutable copy of rake laws', () => {
      const laws = RakeService.getLaws();
      expect(laws.RAKE_PERCENT).toBe(0.1);
      expect(laws.TOURNAMENT_RAKE).toBe(0.1);

      // Verify it's a copy (immutable)
      laws.RAKE_PERCENT = 999 as any;
      const laws2 = RakeService.getLaws();
      expect(laws2.RAKE_PERCENT).toBe(0.1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // INTEGER ARITHMETIC PRECISION
  // ─────────────────────────────────────────────────────────────────────────

  describe('integer arithmetic precision', () => {
    it('should avoid floating point errors in rake calculation', () => {
      // 0.1 + 0.2 ≠ 0.3 in IEEE 754, but ×100 integer arithmetic fixes this
      const result = RakeService.calculateRake(3, 0.2, true, 0.1);
      // 10% of 3 = 0.3, capped at 3 (tier 0.1/0.2)
      expect(result.rawRake).toBe(0.3);
      expect(Number.isInteger(result.rawRake * 100)).toBe(true);
    });

    it('should never produce fractional cent values', () => {
      const result = RakeService.calculateRake(33.33, 2, true, 1);
      // All values should have at most 2 decimal places
      expect(result.rawRake * 100).toBe(Math.trunc(result.rawRake * 100));
      expect(result.cappedRake * 100).toBe(Math.trunc(result.cappedRake * 100));
    });
  });
});
