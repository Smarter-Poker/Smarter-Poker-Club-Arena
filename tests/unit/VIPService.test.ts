/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — VIPService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests VIP constants and pure lookup methods:
 * - VIP_GOLD_LIMITS constant integrity
 * - FEATURE_PRICING constant integrity
 * - getFeaturePricing / getAllPricing / getGoldBenefits pure lookups
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/lib/supabase', () => {
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
  return {
    supabase: {
      from: () => buildChain(),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  };
});

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { vipService, VIP_GOLD_LIMITS, FEATURE_PRICING } from '../../src/services/VIPService';

describe('VIPService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // VIP_GOLD_LIMITS
  // ─────────────────────────────────────────────────────────────────────────

  describe('VIP_GOLD_LIMITS', () => {
    it('gives VIP 100 free rabbit hunts a month, not unlimited', () => {
      // Dan 2026-08-25, verbatim: "vip members get 100 rabbit hunts a month for
      // free, and they cost 5 diamonds each after that." This asserted Infinity
      // until that day, so the UI promised unlimited free hunts while the
      // server's fn_consume_rabbit_hunt starts charging at the 101st.
      expect(VIP_GOLD_LIMITS.rabbitHunts).toBe(100);
    });

    it('should enable showStackBB, offlineProtection, autoTimeBank', () => {
      expect(VIP_GOLD_LIMITS.showStackBB).toBe(true);
      expect(VIP_GOLD_LIMITS.offlineProtection).toBe(true);
      expect(VIP_GOLD_LIMITS.autoTimeBank).toBe(true);
    });

    it('should have 120 time bank seconds', () => {
      expect(VIP_GOLD_LIMITS.timeBankSeconds).toBe(120);
    });

    it('should have 1200 emojis and 1000 tags', () => {
      expect(VIP_GOLD_LIMITS.emojis).toBe(1200);
      expect(VIP_GOLD_LIMITS.tags).toBe(1000);
    });

    it('should have 6% leaderboard boost', () => {
      expect(VIP_GOLD_LIMITS.leaderboardBoost).toBe(0.06);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // FEATURE_PRICING
  // ─────────────────────────────────────────────────────────────────────────

  describe('FEATURE_PRICING', () => {
    it('should have pricing for all 10 features', () => {
      const features = Object.keys(FEATURE_PRICING);
      expect(features.length).toBe(10);
    });

    it('should have valid usage types', () => {
      const validTypes = ['per_use', 'per_session', 'permanent'];
      for (const [, pricing] of Object.entries(FEATURE_PRICING)) {
        expect(validTypes).toContain(pricing.usageType);
      }
    });

    it('should have non-negative costs', () => {
      for (const [, pricing] of Object.entries(FEATURE_PRICING)) {
        expect(pricing.cost).toBeGreaterThanOrEqual(0);
      }
    });

    /**
     * CORRECTED 2026-08-25. These three cases pinned prices that production
     * had never charged, which is why the storefront was able to advertise
     * them for so long. `feature_pricing` in kuklfnapbkmacvwxktbh is the only
     * price that exists — fn_purchase_feature reads it and ignores whatever
     * the client sends. See tests/cosmetic-ownership-integrity.test.ts for the
     * full pinned snapshot and the drift detector.
     */
    it('rabbit_hunt costs 5 diamonds per use, the price the server charges', () => {
      // This asserted 1 for a few hours on 2026-08-25, when the client was
      // reconciled DOWN to the feature_pricing row. Right instinct, wrong
      // direction for this one feature: the row is only the authority on what
      // IS charged, not on what the price is meant to be, and the 1 was a
      // January seed that had never matched the product. Dan: "they cost 5
      // diamonds each after that." The row is 5 now and so is this.
      expect(FEATURE_PRICING.rabbit_hunt.cost).toBe(5);
      expect(FEATURE_PRICING.rabbit_hunt.usageType).toBe('per_use');
    });

    it('show_stack_bb is NOT free — it costs 5 diamonds for the session', () => {
      // It read `cost: 0` with the description "(FREE)" while the server
      // debited 5. A member was told free and then charged.
      expect(FEATURE_PRICING.show_stack_bb.cost).toBe(5);
      expect(FEATURE_PRICING.show_stack_bb.description.toLowerCase()).not.toContain('free');
    });

    it('offline_protection is NOT free — it costs 10 diamonds for the session', () => {
      expect(FEATURE_PRICING.offline_protection.cost).toBe(10);
      expect(FEATURE_PRICING.offline_protection.description.toLowerCase()).not.toContain('free');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PURE METHODS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getFeaturePricing', () => {
    it('should return pricing for rabbit_hunt', () => {
      const pricing = vipService.getFeaturePricing('rabbit_hunt');
      expect(pricing.cost).toBe(5);
      expect(pricing.description).toContain('Cards');
    });
  });

  describe('getAllPricing', () => {
    it('should return all pricing entries', () => {
      const all = vipService.getAllPricing();
      expect(Object.keys(all).length).toBe(10);
    });
  });

  describe('getGoldBenefits', () => {
    it('should return VIP_GOLD_LIMITS', () => {
      const benefits = vipService.getGoldBenefits();
      expect(benefits).toEqual(VIP_GOLD_LIMITS);
    });
  });
});
