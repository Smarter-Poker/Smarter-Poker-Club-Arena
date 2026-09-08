/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — DiamondService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests diamond economy logic:
 * - Package catalog validation (6 packages)
 * - Bonus diamond calculations (total = base + bonus)
 * - Invalid package guard
 * - Price tier progression
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
    rpc: vi.fn().mockResolvedValue({ data: { success: true, new_balance: 500 }, error: null }),
    functions: {
      invoke: vi
        .fn()
        .mockResolvedValue({ data: null, error: { message: 'edge function not available' } }),
    },
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

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { DiamondService, DIAMOND_PACKAGES } from '../../src/services/DiamondService';

describe('DiamondService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PACKAGE CATALOG
  // ─────────────────────────────────────────────────────────────────────────

  describe('DIAMOND_PACKAGES', () => {
    it('should have exactly 6 packages', () => {
      expect(DIAMOND_PACKAGES).toHaveLength(6);
    });

    it('should have unique IDs for every package', () => {
      const ids = DIAMOND_PACKAGES.map((p) => p.id);
      expect(new Set(ids).size).toBe(6);
    });

    it('should have increasing diamond amounts', () => {
      for (let i = 1; i < DIAMOND_PACKAGES.length; i++) {
        expect(DIAMOND_PACKAGES[i].diamonds).toBeGreaterThan(DIAMOND_PACKAGES[i - 1].diamonds);
      }
    });

    it('should have increasing prices', () => {
      for (let i = 1; i < DIAMOND_PACKAGES.length; i++) {
        expect(DIAMOND_PACKAGES[i].priceUSD).toBeGreaterThan(DIAMOND_PACKAGES[i - 1].priceUSD);
      }
    });

    it('should mark exactly one package as popular', () => {
      const popular = DIAMOND_PACKAGES.filter((p) => p.popular);
      expect(popular).toHaveLength(1);
      expect(popular[0].id).toBe('popular');
    });

    it('should mark exactly one package as bestValue', () => {
      const bestValue = DIAMOND_PACKAGES.filter((p) => p.bestValue);
      expect(bestValue).toHaveLength(1);
      expect(bestValue[0].id).toBe('elite');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BONUS CALCULATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('bonus calculation', () => {
    it('starter has 0 bonus diamonds', () => {
      const pkg = DIAMOND_PACKAGES.find((p) => p.id === 'starter')!;
      expect(pkg.bonusDiamonds).toBe(0);
      expect(pkg.diamonds + pkg.bonusDiamonds).toBe(100);
    });

    it('popular has +50 bonus (total 550)', () => {
      const pkg = DIAMOND_PACKAGES.find((p) => p.id === 'popular')!;
      expect(pkg.diamonds + pkg.bonusDiamonds).toBe(550);
    });

    it('whale has +5000 bonus (total 20000)', () => {
      const pkg = DIAMOND_PACKAGES.find((p) => p.id === 'whale')!;
      expect(pkg.diamonds + pkg.bonusDiamonds).toBe(20000);
    });

    it('bonus increases with tier', () => {
      // Higher tiers give proportionally more bonus
      const starter = DIAMOND_PACKAGES.find((p) => p.id === 'starter')!;
      const whale = DIAMOND_PACKAGES.find((p) => p.id === 'whale')!;
      const starterBonusRatio = starter.bonusDiamonds / starter.diamonds;
      const whaleBonusRatio = whale.bonusDiamonds / whale.diamonds;
      expect(whaleBonusRatio).toBeGreaterThan(starterBonusRatio);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PURCHASE FLOW
  // ─────────────────────────────────────────────────────────────────────────

  describe('purchaseDiamonds', () => {
    it('should reject invalid package ID', async () => {
      const result = await DiamondService.purchaseDiamonds('user-1', 'nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid package');
    });

    /**
     * 2026-09-08 (store readiness, phase 3). The "legacy / dev" branch that
     * credited a package through fn_add_diamonds with no payment is gone. A
     * purchase is a store receipt (the app) or a Stripe Checkout session (the
     * web); without a payment method this refuses, calls no RPC, and emits no
     * balance change. The three pins that guarded that branch's "a null
     * payload is not a credit" rule are subsumed: there is no payload at all.
     */
    it('refuses a package with no payment, and never calls a credit RPC', async () => {
      const { supabase } = await import('../../src/lib/supabase');
      vi.mocked(supabase.rpc).mockClear();
      const result = await DiamondService.purchaseDiamonds('user-1', 'starter');
      expect(result.success).toBe(false);
      expect(result.newBalance).toBeUndefined();
      expect(result.error).toContain('Store Or Stripe Checkout');
      expect(supabase.rpc).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // VALUE PER DOLLAR
  // ─────────────────────────────────────────────────────────────────────────

  describe('value per dollar', () => {
    it('higher tiers should offer more diamonds per dollar', () => {
      const starter = DIAMOND_PACKAGES.find((p) => p.id === 'starter')!;
      const whale = DIAMOND_PACKAGES.find((p) => p.id === 'whale')!;

      const starterDPD = (starter.diamonds + starter.bonusDiamonds) / starter.priceUSD;
      const whaleDPD = (whale.diamonds + whale.bonusDiamonds) / whale.priceUSD;

      expect(whaleDPD).toBeGreaterThan(starterDPD);
    });
  });
});
