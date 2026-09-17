/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — VIPService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests VIP constants and pure lookup methods:
 * - VIP_MONTHLY_ALLOWANCES constant integrity
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

import {
  vipService,
  VIP_MONTHLY_ALLOWANCES,
  FEATURE_PRICING,
  normalizeVIPPurchaseError,
} from '../../src/services/VIPService';
import { supabase } from '../../src/lib/supabase';

describe('VIPService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // VIP_MONTHLY_ALLOWANCES
  // ─────────────────────────────────────────────────────────────────────────

  describe('VIP_MONTHLY_ALLOWANCES', () => {
    it('gives VIP 100 free rabbit hunts a month, not unlimited', () => {
      // Dan 2026-08-25, verbatim: "vip members get 100 rabbit hunts a month for
      // free, and they cost 5 diamonds each after that." This asserted Infinity
      // until that day, so the UI promised unlimited free hunts while the
      // server's fn_consume_rabbit_hunt starts charging at the 101st.
      expect(VIP_MONTHLY_ALLOWANCES.rabbitHunts).toBe(100);
    });

    it('should enable showStackBB, offlineProtection, autoTimeBank', () => {
      expect(VIP_MONTHLY_ALLOWANCES.showStackBB).toBe(true);
      expect(VIP_MONTHLY_ALLOWANCES.offlineProtection).toBe(true);
      expect(VIP_MONTHLY_ALLOWANCES.autoTimeBank).toBe(true);
    });

    it('should have 120 time bank seconds', () => {
      expect(VIP_MONTHLY_ALLOWANCES.timeBankSeconds).toBe(120);
    });

    it('should have 1200 emojis and 1000 tags', () => {
      expect(VIP_MONTHLY_ALLOWANCES.emojis).toBe(1200);
      expect(VIP_MONTHLY_ALLOWANCES.tags).toBe(1000);
    });

    it('advertises nothing the platform does not implement', () => {
      // Removed 2026-09-05 with src/constants/vipTiers.ts. Each was quoted to
      // members on /vip and /profile, and none of the three existed:
      //   leaderboardBoost 0.06  LeaderboardService applies no boost.
      //   themes 3               nothing reads it; Table Studio sells singly.
      //   clubCreation 3         fn_get_club_creation_eligibility caps EVERYONE
      //                          at 4 club memberships, VIP or not.
      expect(VIP_MONTHLY_ALLOWANCES).not.toHaveProperty('leaderboardBoost');
      expect(VIP_MONTHLY_ALLOWANCES).not.toHaveProperty('themes');
      expect(VIP_MONTHLY_ALLOWANCES).not.toHaveProperty('clubCreation');
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
    it('should return VIP_MONTHLY_ALLOWANCES', () => {
      const benefits = vipService.getGoldBenefits();
      expect(benefits).toEqual(VIP_MONTHLY_ALLOWANCES);
    });
  });

  describe('Lifetime VIP digital entitlements', () => {
    it('returns unmetered access for the exact Lifetime membership', async () => {
      const statusSpy = vi.spyOn(vipService, 'checkVIPStatus').mockResolvedValue({
        isVIP: true,
        status: 'lifetime',
        expiresAt: null,
        monthlyLimits: {
          rabbitHunts: { used: 100, limit: 100 },
          timeBankSeconds: { used: 120, limit: 120 },
          emojis: { used: 1200, limit: 1200 },
          tags: { used: 1000, limit: 1000 },
          throwables: { used: 500, limit: 500 },
        },
      });

      for (const feature of [
        'rabbit_hunt',
        'show_stack_bb',
        'offline_protection',
        'auto_time_bank',
        'time_bank_seconds',
        'throwable',
        'emoji_pack',
        'tag_pack',
      ] as const) {
        await expect(
          vipService.checkFeatureAccess('11111111-2222-4333-8444-555555555555', feature)
        ).resolves.toEqual({
          hasAccess: true,
          isVIP: true,
          isLifetime: true,
          needsPurchase: false,
        });
      }
      statusSpy.mockRestore();
    });

    it('does not revive the retired generic theme SKU for Lifetime', async () => {
      vi.spyOn(vipService, 'checkVIPStatus').mockResolvedValue({
        isVIP: true,
        status: 'lifetime',
        expiresAt: null,
        monthlyLimits: {
          rabbitHunts: { used: 0, limit: 0 },
          timeBankSeconds: { used: 0, limit: 0 },
          emojis: { used: 0, limit: 0 },
          tags: { used: 0, limit: 0 },
          throwables: { used: 0, limit: 0 },
        },
      });

      await expect(
        vipService.checkFeatureAccess('11111111-2222-4333-8444-555555555555', 'theme_unlock')
      ).resolves.toMatchObject({
        hasAccess: false,
        isLifetime: true,
        needsPurchase: true,
      });
    });

    it('does not write a finite monthly quota for a Lifetime use', async () => {
      const accessSpy = vi.spyOn(vipService, 'checkFeatureAccess').mockResolvedValue({
        hasAccess: true,
        isVIP: true,
        isLifetime: true,
        needsPurchase: false,
      });
      const consumeSpy = vi.spyOn(vipService as any, 'consumeVIPQuota');
      const purchaseConsumeSpy = vi.spyOn(vipService as any, 'consumePurchase');

      await expect(
        vipService.useFeature('11111111-2222-4333-8444-555555555555', 'throwable')
      ).resolves.toEqual({ success: true, charged: 0 });
      expect(consumeSpy).not.toHaveBeenCalled();
      expect(purchaseConsumeSpy).not.toHaveBeenCalled();
      accessSpy.mockRestore();
      consumeSpy.mockRestore();
      purchaseConsumeSpy.mockRestore();
    });

    it('does not grant the ownership-changing Club Creation feature automatically', async () => {
      const statusSpy = vi.spyOn(vipService, 'checkVIPStatus').mockResolvedValue({
        isVIP: true,
        status: 'lifetime',
        expiresAt: null,
        monthlyLimits: {
          rabbitHunts: { used: 0, limit: 100 },
          timeBankSeconds: { used: 0, limit: 120 },
          emojis: { used: 0, limit: 1200 },
          tags: { used: 0, limit: 1000 },
          throwables: { used: 0, limit: 500 },
        },
      });

      await expect(
        vipService.checkFeatureAccess('11111111-2222-4333-8444-555555555555', 'club_creation')
      ).resolves.toEqual({
        hasAccess: false,
        isVIP: true,
        isLifetime: true,
        needsPurchase: true,
        diamondCost: 100,
        usageType: 'permanent',
      });
      statusSpy.mockRestore();
    });
  });

  describe('purchase refusal copy', () => {
    it('maps database refusals to safe Title Case messages', () => {
      expect(normalizeVIPPurchaseError('authentication required')).toBe('Authentication Required');
      expect(normalizeVIPPurchaseError('unknown feature')).toBe('Feature Is Not Available');
      expect(normalizeVIPPurchaseError('Insufficient diamonds')).toBe('Insufficient Diamonds');
      expect(normalizeVIPPurchaseError('internal schema detail -- do not display')).toBe(
        'Purchase Failed'
      );
    });

    it('never forwards a transport error verbatim to the VIP page', async () => {
      (supabase.rpc as any).mockResolvedValueOnce({
        data: null,
        error: { message: 'lowercase private database detail' },
      });

      await expect(
        vipService.purchaseFeature('11111111-2222-4333-8444-555555555555', 'rabbit_hunt')
      ).resolves.toMatchObject({
        success: false,
        charged: 0,
        error: 'Purchase Failed',
      });
    });

    it('normalizes a database refusal carried in a successful RPC response', async () => {
      (supabase.rpc as any).mockResolvedValueOnce({
        data: { success: false, error: 'Insufficient diamonds' },
        error: null,
      });

      await expect(
        vipService.purchaseFeature('11111111-2222-4333-8444-555555555555', 'rabbit_hunt')
      ).resolves.toMatchObject({
        success: false,
        charged: 0,
        error: 'Insufficient Diamonds',
      });
    });

    it('reuses one request UUID after transport ambiguity and rotates it after success', async () => {
      const userId = '99999999-2222-4333-8444-555555555555';
      (supabase.rpc as any)
        .mockResolvedValueOnce({ data: null, error: { message: 'network response lost' } })
        .mockResolvedValueOnce({
          data: { success: true, cost: 5, idempotent: true, granted: false },
          error: null,
        })
        .mockResolvedValueOnce({
          data: { success: true, cost: 5, idempotent: false, granted: true },
          error: null,
        });

      await vipService.purchaseFeature(userId, 'rabbit_hunt');
      const replay = await vipService.purchaseFeature(userId, 'rabbit_hunt');
      await vipService.purchaseFeature(userId, 'rabbit_hunt');

      expect(replay).toMatchObject({ success: true, charged: 0, idempotent: true });

      const calls = (supabase.rpc as any).mock.calls.filter(
        ([name]: [string]) => name === 'fn_purchase_feature_v2'
      );
      expect(calls).toHaveLength(3);
      expect(calls[0][1].p_request_id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(calls[1][1].p_request_id).toBe(calls[0][1].p_request_id);
      expect(calls[2][1].p_request_id).not.toBe(calls[1][1].p_request_id);
    });

    it('keeps an ambiguous account A request through an account B purchase', async () => {
      const accountA = 'aaaaaaaa-2222-4333-8444-555555555555';
      const accountB = 'bbbbbbbb-2222-4333-8444-555555555555';
      (supabase.rpc as any)
        .mockResolvedValueOnce({ data: null, error: { message: 'response lost after commit' } })
        .mockResolvedValueOnce({
          data: { success: true, cost: 1, idempotent: false, granted: true },
          error: null,
        })
        .mockResolvedValueOnce({
          data: { success: true, cost: 1, idempotent: true, granted: false },
          error: null,
        });

      await vipService.purchaseFeature(accountA, 'tag_pack');
      await vipService.purchaseFeature(accountB, 'tag_pack');
      await vipService.purchaseFeature(accountA, 'tag_pack');

      const calls = (supabase.rpc as any).mock.calls.filter(
        ([name]: [string]) => name === 'fn_purchase_feature_v2'
      );
      expect(calls).toHaveLength(3);
      expect(calls[0][1].p_request_id).toBe(calls[2][1].p_request_id);
      expect(calls[1][1].p_request_id).not.toBe(calls[0][1].p_request_id);
      expect(calls[0][1].p_user_id).toBe(accountA);
      expect(calls[1][1].p_user_id).toBe(accountB);
    });
  });
});
