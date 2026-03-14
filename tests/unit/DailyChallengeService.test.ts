/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — DailyChallengeService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests the CHALLENGE_POOL catalog and pure utility logic.
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

vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../../src/services/WalletService', () => ({
  WalletService: {
    logTransaction: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: <T>(fn: () => Promise<T>) => fn(),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import {
  CHALLENGE_POOL,
  WEEKLY_CHALLENGE_POOL,
  MONTHLY_CHALLENGE_POOL,
} from '../../src/services/DailyChallengeService';

describe('DailyChallengeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CHALLENGE POOL INTEGRITY
  // ─────────────────────────────────────────────────────────────────────────

  describe('CHALLENGE_POOL', () => {
    it('should contain at least 11 daily challenges', () => {
      expect(CHALLENGE_POOL.length).toBeGreaterThanOrEqual(11);
    });

    it('should have unique IDs', () => {
      const ids = CHALLENGE_POOL.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should have positive requirements and rewards', () => {
      for (const c of CHALLENGE_POOL) {
        expect(c.requirement).toBeGreaterThan(0);
        expect(c.chipReward).toBeGreaterThan(0);
      }
    });

    it('should have valid challenge types', () => {
      const validTypes = [
        'hands_played',
        'hands_won',
        'showdowns',
        'tournaments_played',
        'login_streak',
        'rakeback_earned',
        'friends_added',
      ];
      for (const c of CHALLENGE_POOL) {
        expect(validTypes).toContain(c.type);
      }
    });
  });

  describe('WEEKLY_CHALLENGE_POOL', () => {
    it('should contain at least 4 weekly challenges', () => {
      expect(WEEKLY_CHALLENGE_POOL.length).toBeGreaterThanOrEqual(4);
    });

    it('should have higher rewards than daily challenges', () => {
      const maxDaily = Math.max(...CHALLENGE_POOL.map((c) => c.chipReward));
      const minWeekly = Math.min(...WEEKLY_CHALLENGE_POOL.map((c) => c.chipReward));
      expect(minWeekly).toBeGreaterThanOrEqual(maxDaily);
    });

    it('should have unique IDs', () => {
      const ids = WEEKLY_CHALLENGE_POOL.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('MONTHLY_CHALLENGE_POOL', () => {
    it('should contain at least 3 monthly challenges', () => {
      expect(MONTHLY_CHALLENGE_POOL.length).toBeGreaterThanOrEqual(3);
    });

    it('should have the highest rewards', () => {
      const maxWeekly = Math.max(...WEEKLY_CHALLENGE_POOL.map((c) => c.chipReward));
      const minMonthly = Math.min(...MONTHLY_CHALLENGE_POOL.map((c) => c.chipReward));
      expect(minMonthly).toBeGreaterThanOrEqual(maxWeekly);
    });

    it('should have unique IDs', () => {
      const ids = MONTHLY_CHALLENGE_POOL.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // NO ID COLLISIONS ACROSS POOLS
  // ─────────────────────────────────────────────────────────────────────────

  describe('Cross-pool uniqueness', () => {
    it('should have no duplicate IDs across all challenge pools', () => {
      const allIds = [
        ...CHALLENGE_POOL.map((c) => c.id),
        ...WEEKLY_CHALLENGE_POOL.map((c) => c.id),
        ...MONTHLY_CHALLENGE_POOL.map((c) => c.id),
      ];
      expect(new Set(allIds).size).toBe(allIds.length);
    });
  });
});
