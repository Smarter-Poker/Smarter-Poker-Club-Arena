/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — ArenaTrainingController
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests LEVELS configuration, MASTERY_THRESHOLD, MIN_QUESTIONS,
 * checkLevelAccess for level 1, getUnlockedLevel fallback,
 * and ArenaTrainingController export shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock dependencies ────────────────────────────────────────────────────

vi.mock('@/lib/supabase', () => {
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
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    },
  };
});

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: vi.fn().mockResolvedValue({ data: null, error: { message: 'Not available' } }),
}));

// ─── Import AFTER mocks ──────────────────────────────────────────────────

import {
  LEVELS,
  MASTERY_THRESHOLD,
  MIN_QUESTIONS,
  checkLevelAccess,
  getUnlockedLevel,
  ArenaTrainingController,
} from '../../src/services/ArenaTrainingController';

describe('ArenaTrainingController', () => {
  beforeEach(() => vi.clearAllMocks());

  // ─────────────────────────────────────────────────────────────────────────
  // LEVELS configuration
  // ─────────────────────────────────────────────────────────────────────────

  describe('LEVELS', () => {
    it('should have exactly 10 levels', () => {
      expect(LEVELS).toHaveLength(10);
    });

    it('each level should have unique level number 1-10', () => {
      const numbers = LEVELS.map((l) => l.level);
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('timer should decrease as levels increase (harder = less time)', () => {
      for (let i = 1; i < LEVELS.length; i++) {
        expect(LEVELS[i].timer_seconds).toBeLessThanOrEqual(LEVELS[i - 1].timer_seconds);
      }
    });

    it('all levels should require 85% mastery threshold', () => {
      for (const level of LEVELS) {
        expect(level.mastery_threshold).toBe(0.85);
      }
    });

    it('all levels should require 20 minimum questions', () => {
      for (const level of LEVELS) {
        expect(level.min_questions).toBe(20);
      }
    });

    it('level 1 should be Foundations with 30s timer', () => {
      expect(LEVELS[0].name).toBe('Foundations');
      expect(LEVELS[0].timer_seconds).toBe(30);
      expect(LEVELS[0].difficulty).toBe('easy');
    });

    it('level 10 should be Elite GTO with 8s timer', () => {
      expect(LEVELS[9].name).toBe('Elite GTO');
      expect(LEVELS[9].timer_seconds).toBe(8);
      expect(LEVELS[9].difficulty).toBe('master');
    });

    it('difficulty should progress easy → medium → hard → expert → master', () => {
      expect(LEVELS[0].difficulty).toBe('easy');
      expect(LEVELS[2].difficulty).toBe('medium');
      expect(LEVELS[5].difficulty).toBe('hard');
      expect(LEVELS[7].difficulty).toBe('expert');
      expect(LEVELS[9].difficulty).toBe('master');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Constants
  // ─────────────────────────────────────────────────────────────────────────

  describe('constants', () => {
    it('MASTERY_THRESHOLD should be 0.85', () => {
      expect(MASTERY_THRESHOLD).toBe(0.85);
    });

    it('MIN_QUESTIONS should be 20', () => {
      expect(MIN_QUESTIONS).toBe(20);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // checkLevelAccess
  // ─────────────────────────────────────────────────────────────────────────

  describe('checkLevelAccess', () => {
    it('should return true for level 1 (always accessible)', async () => {
      expect(await checkLevelAccess('user-1', 1)).toBe(true);
    });

    it('should return false for higher levels when RPC fails', async () => {
      expect(await checkLevelAccess('user-1', 5)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getUnlockedLevel
  // ─────────────────────────────────────────────────────────────────────────

  describe('getUnlockedLevel', () => {
    it('should return 1 when no sessions found', async () => {
      expect(await getUnlockedLevel('user-1')).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Export shape
  // ─────────────────────────────────────────────────────────────────────────

  describe('ArenaTrainingController export', () => {
    it('should export all methods and constants', () => {
      expect(ArenaTrainingController.LEVELS).toBe(LEVELS);
      expect(ArenaTrainingController.MASTERY_THRESHOLD).toBe(0.85);
      expect(ArenaTrainingController.MIN_QUESTIONS).toBe(20);
      expect(typeof ArenaTrainingController.startSession).toBe('function');
      expect(typeof ArenaTrainingController.checkLevelAccess).toBe('function');
      expect(typeof ArenaTrainingController.recordAnswer).toBe('function');
      expect(typeof ArenaTrainingController.getUnlockedLevel).toBe('function');
      expect(typeof ArenaTrainingController.getTrainingHistory).toBe('function');
    });
  });
});
