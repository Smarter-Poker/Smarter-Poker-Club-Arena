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
  CHALLENGE_TYPES,
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

    // Derived from CHALLENGE_TYPES, never hand-copied. The previous version
    // duplicated the list here and drifted: big_pots and strong_hands were live
    // in production while this test still asserted against a list that predated
    // them, so it failed on correct code and would have passed on a type nobody
    // could increment.
    it('should have valid challenge types', () => {
      for (const c of [...CHALLENGE_POOL, ...WEEKLY_CHALLENGE_POOL, ...MONTHLY_CHALLENGE_POOL]) {
        expect(CHALLENGE_TYPES as readonly string[]).toContain(c.type);
      }
    });

    // Every assignable challenge must be winnable. A type with no writer means
    // a card that can be handed out and never moves.
    it('every pool type has something in the app that increments it', () => {
      const WRITTEN_BY_APP: Record<string, string> = {
        hands_played: 'AchievementTriggerService.onHandComplete',
        hands_won: 'AchievementTriggerService.onHandComplete',
        showdowns: 'AchievementTriggerService.onHandComplete',
        big_pots: 'AchievementTriggerService.onHandComplete',
        strong_hands: 'AchievementTriggerService.onHandComplete',
        tournaments_played: 'AchievementTriggerService TOURNAMENT_REGISTERED subscriber',
        friends_added: 'AchievementTriggerService.onFriendAdded',
      };
      for (const c of [...CHALLENGE_POOL, ...WEEKLY_CHALLENGE_POOL, ...MONTHLY_CHALLENGE_POOL]) {
        expect(
          WRITTEN_BY_APP[c.type],
          `challenge "${c.id}" has type "${c.type}", which nothing increments -- it could never be completed`
        ).toBeTruthy();
      }
      // And no declared type is dead weight waiting to be used by mistake.
      for (const t of CHALLENGE_TYPES) {
        expect(WRITTEN_BY_APP[t], `challenge type "${t}" has no writer in the app`).toBeTruthy();
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
