/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNIT TESTS — LeaderboardService
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tests leaderboard stat queries with mocked Supabase:
 * - getPlayerStats: returns null for missing user
 * - getClubLeaderboard: returns empty array when no data
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

import { LeaderboardService } from '../../src/services/LeaderboardService';

describe('LeaderboardService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET PLAYER STATS
  // ─────────────────────────────────────────────────────────────────────────

  describe('getPlayerStats', () => {
    it('should return null when no data found', async () => {
      const stats = await LeaderboardService.getPlayerStats('nonexistent-user');
      expect(stats).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET CLUB LEADERBOARD
  // ─────────────────────────────────────────────────────────────────────────

  describe('getClubLeaderboard', () => {
    it('should return empty array when no data', async () => {
      const result = await LeaderboardService.getClubLeaderboard('club-1', 'profit', 'weekly');
      expect(result).toEqual([]);
    });
  });
});
