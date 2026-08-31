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
      from: vi.fn(() => buildChain()),
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  };
});

vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Error && /network|timeout/i.test(error.message)) return fn();
      throw error;
    }
  },
}));

import { LeaderboardService } from '../../src/services/LeaderboardService';

describe('LeaderboardService', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { supabase } = await import('../../src/lib/supabase');
    const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
    rpc.mockReset().mockResolvedValue({ data: null, error: null });
  });

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

    it('does not relabel all-time fallback rows as a period when the strict RPC fails', async () => {
      const { supabase } = await import('../../src/lib/supabase');
      const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
      const from = supabase.from as unknown as ReturnType<typeof vi.fn>;
      rpc.mockResolvedValueOnce({ data: null, error: { message: 'period rpc unavailable' } });

      await expect(
        LeaderboardService.getClubLeaderboard('club-1', 'profit', 'weekly', 10, 0, 0, true)
      ).rejects.toMatchObject({ message: 'period rpc unavailable' });

      expect(from.mock.calls.filter(([table]) => table === 'player_stats')).toHaveLength(0);
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

    it('can surface owner-context transport failures instead of misreporting no authority', async () => {
      const { supabase } = await import('../../src/lib/supabase');
      const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
      rpc.mockResolvedValueOnce({ data: null, error: { message: 'identity read unavailable' } });

      await expect(LeaderboardService.getManageableRewardContexts(true)).rejects.toMatchObject({
        message: 'identity read unavailable',
      });
    });

    it('saves plans without accepting a client-selected funding source', async () => {
      const { supabase } = await import('../../src/lib/supabase');
      const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
      rpc.mockResolvedValueOnce({
        data: { club_id: 'club-1', setup_complete: true, program_version: 1 },
        error: null,
      });

      await LeaderboardService.saveLeaderboardRewardSetup('club-1', {
        rewards_enabled: true,
        payout_metric: 'profit',
        weekly_prizes: [{ rank: 1, amount: 50 }],
        monthly_prizes: [{ rank: 1, amount: 200 }],
        suggestion_key: 'balanced',
        program_version: 0,
      });

      expect(rpc).toHaveBeenCalledWith('fn_save_leaderboard_reward_setup', {
        p_club_id: 'club-1',
        p_rewards_enabled: true,
        p_metric: 'profit',
        p_weekly_prizes: [{ rank: 1, amount: 50 }],
        p_monthly_prizes: [{ rank: 1, amount: 200 }],
        p_suggestion_key: 'balanced',
        p_expected_version: 0,
        p_operation_id: expect.any(String),
      });
      expect(rpc.mock.calls.at(-1)?.[1]).not.toHaveProperty('p_funding_source');
    });

    it('loads the immutable program bound to the selected canonical period', async () => {
      const { supabase } = await import('../../src/lib/supabase');
      const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
      rpc.mockResolvedValueOnce({
        data: {
          program_id: 'program-2',
          program_version: 2,
          program_hash: 'a'.repeat(32),
          status: 'published',
          rewards_enabled: true,
          period: 'weekly',
          period_start: '2026-08-30',
          payout_metric: 'profit',
          prizes: [{ rank: 1, amount: 50 }],
          funding_owner_type: 'union',
          funding_union_id: 'union-1',
          published_at: '2026-08-29T12:00:00Z',
        },
        error: null,
      });

      const plan = await LeaderboardService.getLeaderboardRewardPlan(
        'club-1',
        'weekly',
        '2026-08-30'
      );

      expect(rpc).toHaveBeenCalledWith('fn_get_leaderboard_reward_plan', {
        p_club_id: 'club-1',
        p_period: 'weekly',
        p_period_start: '2026-08-30',
      });
      expect(plan?.program_version).toBe(2);
    });

    it('reuses one publication key across a transient lost-response retry', async () => {
      const { supabase } = await import('../../src/lib/supabase');
      const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
      rpc
        .mockResolvedValueOnce({ data: null, error: { message: 'network timeout' } })
        .mockResolvedValueOnce({
          data: { club_id: 'club-1', setup_complete: true, program_version: 1 },
          error: null,
        });

      await LeaderboardService.saveLeaderboardRewardSetup('club-1', {
        rewards_enabled: true,
        payout_metric: 'profit',
        weekly_prizes: [{ rank: 1, amount: 50 }],
        monthly_prizes: [],
        suggestion_key: 'custom',
        program_version: 0,
      });

      expect(rpc).toHaveBeenCalledTimes(2);
      expect(rpc.mock.calls[0][1].p_operation_id).toBe(rpc.mock.calls[1][1].p_operation_id);
    });
  });

  describe('canonical leaderboard periods', () => {
    const canonicalWeek = {
      period: 'weekly',
      period_offset: -1,
      timezone: 'UTC',
      start_date: '2026-08-16',
      end_date: '2026-08-23',
      start_at: '2026-08-16T00:00:00+00:00',
      end_at: '2026-08-23T00:00:00+00:00',
      is_current: false,
      label: 'Aug 16 - Aug 22',
    };

    it('loads UTC calendar boundaries from the database instead of browser-local dates', async () => {
      const { supabase } = await import('../../src/lib/supabase');
      const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
      rpc.mockResolvedValueOnce({ data: [canonicalWeek], error: null });

      const window = await LeaderboardService.getPeriodWindow('weekly', -1);

      expect(rpc).toHaveBeenCalledWith('fn_leaderboard_period_window', {
        p_period: 'weekly',
        p_period_offset: -1,
      });
      expect(window).toEqual(canonicalWeek);
    });

    it('uses the server-owned window for historical club rankings', async () => {
      const { supabase } = await import('../../src/lib/supabase');
      const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
      rpc.mockImplementation(async (name: string) => {
        if (name === 'fn_leaderboard_period_window') {
          return { data: [canonicalWeek], error: null };
        }
        if (name === 'fn_club_leaderboard_by_dates') {
          return { data: [], error: null };
        }
        return { data: null, error: null };
      });

      await LeaderboardService.getClubLeaderboard(
        'a0000000-0000-0000-0000-000000000001',
        'profit',
        'weekly',
        50,
        0,
        -1,
        true
      );

      expect(rpc).toHaveBeenCalledWith('fn_club_leaderboard_by_dates', {
        p_club_id: 'a0000000-0000-0000-0000-000000000001',
        p_metric: 'profit',
        p_start_date: canonicalWeek.start_date,
        p_end_date: canonicalWeek.end_date,
        p_limit: 50,
        p_offset: 0,
      });
    });

    it('normalizes the historical personal-rank table row returned by PostgREST', async () => {
      const { supabase } = await import('../../src/lib/supabase');
      const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
      rpc.mockImplementation(async (name: string) => {
        if (name === 'fn_leaderboard_period_window') {
          return { data: [canonicalWeek], error: null };
        }
        if (name === 'fn_user_rank_by_dates') {
          return { data: [{ rank: 4, total: 88, value: 125.5, found: true }], error: null };
        }
        return { data: null, error: null };
      });

      const rank = await LeaderboardService.getUserRank(
        'b0000000-0000-0000-0000-000000000002',
        'a0000000-0000-0000-0000-000000000001',
        'profit',
        'weekly',
        -1
      );

      expect(rank).toEqual({ rank: 4, total: 88, value: 125.5 });
    });

    it('fails closed when the canonical window cannot be loaded', async () => {
      const { supabase } = await import('../../src/lib/supabase');
      const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
      rpc.mockResolvedValueOnce({ data: null, error: { message: 'window unavailable' } });

      await expect(LeaderboardService.getPeriodWindow('monthly', 0)).rejects.toMatchObject({
        message: 'window unavailable',
      });
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

  it('does not publish a known-truncated fallback when strict server aggregation fails', async () => {
    const { supabase } = await import('../../src/lib/supabase');
    const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
    const from = supabase.from as unknown as ReturnType<typeof vi.fn>;
    from.mockClear();
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'aggregate rpc unavailable' } });

    await expect(
      LeaderboardService.getClubTournamentStats('club-1', 50, 0, true)
    ).rejects.toMatchObject({ message: 'aggregate rpc unavailable' });

    expect(from.mock.calls.filter(([table]) => table === 'tournament_players')).toHaveLength(0);
  });
});
