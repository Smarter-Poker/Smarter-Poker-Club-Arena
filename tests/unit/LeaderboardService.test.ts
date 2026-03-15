/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — LeaderboardService (Strengthened)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { LeaderboardService } from '../../src/services/LeaderboardService';

describe('LeaderboardService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getPlayerStats', () => {
    it('should return null when no data found', async () => {
      const stats = await LeaderboardService.getPlayerStats('nonexistent-user');
      expect(stats).toBeNull();
    });

    it('should accept any userId string', async () => {
      const stats = await LeaderboardService.getPlayerStats('');
      expect(stats).toBeNull();
    });
  });

  describe('getClubLeaderboard', () => {
    it('should return empty array when no data', async () => {
      const result = await LeaderboardService.getClubLeaderboard('club-1', 'profit', 'weekly');
      expect(result).toEqual([]);
    });

    it('should accept different metric types', async () => {
      const profit = await LeaderboardService.getClubLeaderboard('club-1', 'profit', 'weekly');
      const hands = await LeaderboardService.getClubLeaderboard('club-1', 'hands', 'daily');
      expect(Array.isArray(profit)).toBe(true);
      expect(Array.isArray(hands)).toBe(true);
    });

    it('should accept different period types', async () => {
      const daily = await LeaderboardService.getClubLeaderboard('club-1', 'profit', 'daily');
      const monthly = await LeaderboardService.getClubLeaderboard('club-1', 'profit', 'monthly');
      expect(Array.isArray(daily)).toBe(true);
      expect(Array.isArray(monthly)).toBe(true);
    });
  });

  describe('export shape', () => {
    it('should export LeaderboardService with all methods', () => {
      expect(typeof LeaderboardService.getPlayerStats).toBe('function');
      expect(typeof LeaderboardService.getClubLeaderboard).toBe('function');
    });
  });
});
