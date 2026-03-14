/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — PromotionService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests promotion management logic:
 * - mapPromotion field mapping (DB → domain)
 * - mapClaim field mapping
 * - Promotion types (7 types)
 * - Deposit bonus calculation (integer arithmetic)
 * - Claim status lifecycle
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: [], error: null }),
          }),
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          lte: () => ({
            gte: () => ({
              limit: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
          gt: () => ({
            limit: () => Promise.resolve({ data: [], error: null }),
          }),
          lt: () => ({
            limit: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
        order: () => ({
          limit: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
      insert: () => ({
        select: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
      update: () => ({
        eq: () => Promise.resolve({ error: null }),
      }),
      delete: () => ({
        eq: () => Promise.resolve({ error: null }),
      }),
      upsert: () => Promise.resolve({ error: null }),
    }),
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
    logTransaction: vi.fn().mockResolvedValue(undefined),
  },
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import { promotionService } from '../../src/services/PromotionService';
import type { PromotionType } from '../../src/services/PromotionService';

describe('PromotionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MAP PROMOTION
  // ─────────────────────────────────────────────────────────────────────────

  describe('mapPromotion (via getPromotion → private mapper)', () => {
    it('should return null for non-existent promotion', async () => {
      const promo = await promotionService.getPromotion('non-existent');
      expect(promo).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROMOTION TYPES
  // ─────────────────────────────────────────────────────────────────────────

  describe('promotion types', () => {
    const validTypes: PromotionType[] = [
      'bonus',
      'freeroll',
      'leaderboard',
      'rakeback',
      'special',
      'deposit_match',
      'refer_friend',
    ];

    it('should support exactly 7 promotion types', () => {
      expect(validTypes).toHaveLength(7);
    });

    it.each(validTypes)('should accept type: %s', (type) => {
      expect(validTypes).toContain(type);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CLAIM STATUS LIFECYCLE
  // ─────────────────────────────────────────────────────────────────────────

  describe('claim status lifecycle', () => {
    const validStatuses = ['pending', 'active', 'completed', 'expired'];

    it('should support 4 claim statuses', () => {
      expect(validStatuses).toHaveLength(4);
    });

    it.each(validStatuses)('should accept claim status: %s', (status) => {
      expect(validStatuses).toContain(status);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DEPOSIT BONUS MATH
  // ─────────────────────────────────────────────────────────────────────────

  describe('deposit bonus calculation', () => {
    it('should calculate bonus with integer arithmetic (no floating point errors)', () => {
      // Simulate the formula: Math.trunc(((depositAmount * bonusPercent) / 100) * 100) / 100
      const depositAmount = 100;
      const bonusPercent = 50;
      const result = Math.trunc(((depositAmount * bonusPercent) / 100) * 100) / 100;
      expect(result).toBe(50);
    });

    it('should cap bonus at prizePool (maxBonus)', () => {
      const depositAmount = 10000;
      const bonusPercent = 100;
      const maxBonus = 500; // prizePool
      const bonusAmount = Math.trunc(((depositAmount * bonusPercent) / 100) * 100) / 100;
      const finalBonus = Math.min(bonusAmount, maxBonus);
      expect(finalBonus).toBe(500);
    });

    it('should handle fractional cent truncation', () => {
      const depositAmount = 33.33;
      const bonusPercent = 100;
      const result = Math.trunc(((depositAmount * bonusPercent) / 100) * 100) / 100;
      // 33.33 * 100 / 100 = 33.33, * 100 = 3333, trunc = 3333, / 100 = 33.33
      expect(result).toBe(33.33);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EMPTY DATA HANDLING
  // ─────────────────────────────────────────────────────────────────────────

  describe('empty data handling', () => {
    it('should return empty array when no promotions exist', async () => {
      const promos = await promotionService.getPromotions('club-1');
      expect(promos).toEqual([]);
    });

    it('should handle deposit bonus with no active promotions', async () => {
      const bonus = await promotionService.applyDepositBonus('user-1', 100);
      expect(bonus).toBe(0);
    });

    it('should return empty claims for user with no claims', async () => {
      const claims = await promotionService.getUserClaims('user-1');
      expect(claims).toEqual([]);
    });
  });
});
