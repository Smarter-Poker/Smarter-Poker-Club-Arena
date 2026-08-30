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

    it('surfaces a failed primary load when strict mode is requested', async () => {
      await expect(
        LeaderboardService.getClubLeaderboard('club-1', 'profit', 'weekly', 10, 0, 0, true)
      ).rejects.toThrow('Club leaderboard returned no data');
    });
  });

  describe('export shape', () => {
    it('should export LeaderboardService with all methods', () => {
      expect(typeof LeaderboardService.getPlayerStats).toBe('function');
      expect(typeof LeaderboardService.getClubLeaderboard).toBe('function');
    });
  });

  describe('leaderboard prize setup', () => {
    it('loads only server-authorized owner contexts', async () => {
      const { supabase } = await import('../../src/lib/supabase');
      const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
      rpc.mockResolvedValueOnce({
        data: [
          {
            club_id: 'club-1',
            club_name: 'River Room',
            union_id: 'union-1',
            union_name: 'North Circuit',
            funding_owner_type: 'union',
            funding_source: 'union_promo_wallet',
            setup_complete: false,
            rewards_enabled: false,
          },
        ],
        error: null,
      });

      const contexts = await LeaderboardService.getManageableRewardContexts();

      expect(rpc).toHaveBeenCalledWith('fn_leaderboard_reward_contexts');
      expect(contexts[0].funding_source).toBe('union_promo_wallet');
    });

    it('saves plans without accepting a client-selected funding source', async () => {
      const { supabase } = await import('../../src/lib/supabase');
      const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
      rpc.mockResolvedValueOnce({
        data: { club_id: 'club-1', setup_complete: true },
        error: null,
      });

      await LeaderboardService.saveLeaderboardRewardSetup('club-1', {
        rewards_enabled: true,
        payout_metric: 'profit',
        weekly_prizes: [{ rank: 1, amount: 50 }],
        monthly_prizes: [{ rank: 1, amount: 200 }],
        suggestion_key: 'balanced',
      });

      expect(rpc).toHaveBeenCalledWith('fn_save_leaderboard_reward_setup', {
        p_club_id: 'club-1',
        p_rewards_enabled: true,
        p_metric: 'profit',
        p_weekly_prizes: [{ rank: 1, amount: 50 }],
        p_monthly_prizes: [{ rank: 1, amount: 200 }],
        p_suggestion_key: 'balanced',
      });
      expect(rpc.mock.calls.at(-1)?.[1]).not.toHaveProperty('p_funding_source');
    });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  getClubTournamentStats — the RPC path, and the fallback that hides its loss
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This method shipped as an RPC on 2026-08-21 and was reverted by a merge the
 * same day, while the migration that created the function sat in the repo
 * unapplied. Nothing failed: the client fallback still returned rows, just the
 * wrong ones — aggregated from raw rows capped at 10,000, which every club
 * exceeds, with no ORDER BY before the cap.
 *
 * So these two tests are deliberately about WHICH PATH RAN, not about whether
 * a result came back. A test that only asserted "returns an array" passed
 * happily through the entire regression.
 */
describe('getClubTournamentStats', () => {
  it('asks the database to do the aggregation, and forwards limit and offset', async () => {
    const { supabase } = await import('../../src/lib/supabase');
    const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
    rpc.mockResolvedValueOnce({
      data: [
        {
          userId: 'u1',
          username: 'hammertime',
          avatar: '/avatars/table/vip_dancer@2x.webp',
          // PostgREST returns numerics as strings; the mapping must coerce.
          tournamentsPlayed: '219',
          wins: '12',
          finalTables: '71',
          itmFinishes: '34',
          totalPrizes: '1184.35',
          roi: '7.668181818181818182',
          biggestWin: '300.00',
        },
      ],
      error: null,
    });

    const rows = await LeaderboardService.getClubTournamentStats('club-1', 25, 50);

    expect(rpc).toHaveBeenCalledWith('fn_club_tournament_stats', {
      p_club_id: 'club-1',
      p_limit: 25,
      p_offset: 50,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].totalPrizes).toBe(1184.35);
    expect(rows[0].tournamentsPlayed).toBe(219);
    expect(rows[0].avatar).toBe('/avatars/table/vip_dancer@2x.webp');
    expect(typeof rows[0].roi).toBe('number');
  });

  it('falls back to client-side aggregation when the function is missing', async () => {
    const { supabase } = await import('../../src/lib/supabase');
    const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
    rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'function public.fn_club_tournament_stats does not exist' },
    });

    // The mocked query chain yields no rows, so the fallback returns []. The
    // assertion that matters is that it did not throw and did not return the
    // RPC's null: a missing function must degrade, never blank the page.
    const rows = await LeaderboardService.getClubTournamentStats('club-1');
    expect(Array.isArray(rows)).toBe(true);
  });
});
