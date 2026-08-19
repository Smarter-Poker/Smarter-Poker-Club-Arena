/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LEADERBOARD SERVICE — Player Rankings & Stats
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages club, union, and GLOBAL leaderboards with:
 * - Daily, weekly, monthly, and all-time rankings (snapshot-delta based)
 * - Multiple metrics: profit, hands played, VPIP, PFR, ROI, tournaments won
 * - Real rank-change tracking (current rank vs yesterday's snapshot rank)
 *
 * 2026-08-19 REAL-PROFIT PIPELINE: player_stats.total_winnings / total_losses
 * are now written on every cash hand (hand_history winner-folding trigger +
 * per-player contribution accumulation in promo_apply_playthrough). Profit is
 * exact net: SUM(won - invested). ROI = (W - L) / L over invested chips.
 * RPCs: fn_club_leaderboard_period_v2, fn_global_leaderboard_period,
 * fn_user_rank_period, fn_user_rank_global_period.
 */

import { supabase } from '../lib/supabase';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface PlayerStatsRow {
  user_id: string;
  hands_played: number;
  total_winnings: number;
  total_losses: number;
  total_rake?: number;
  vpip: number;
  pfr: number;
  tournaments_played?: number;
  tournaments_won: number;
  club_id?: string;
  rank_change?: number;
  qualified?: boolean;
}

interface ProfileRow {
  id: string;
  username: string;
  avatar_url?: string;
  level?: number;
  tier?: string;
}

export type LeaderboardPeriod = 'daily' | 'weekly' | 'monthly' | 'all_time';
export type LeaderboardMetric =
  | 'profit'
  | 'hands_played'
  | 'vpip'
  | 'pfr'
  | 'roi'
  | 'tournaments_won';

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  avatar?: string;
  value: number;
  metric: LeaderboardMetric;
  change: number; // Real position change vs yesterday's snapshot ranking
  isVIP?: boolean;
  vipTier?: string;
  level?: number;
  /** Hands dealt in the selected period - context for rate metrics like ROI. */
  hands?: number;
  /** False when the row fails the ROI volume qualifier; such rows sort last. */
  qualified?: boolean;
}

export interface PlayerStats {
  userId: string;
  handsPlayed: number;
  profit: number;
  vpip: number;
  pfr: number;
  threeBet: number;
  wtsd: number;
  wsd: number;
  aggFactor: number;
  roi: number;
  tournamentsPlayed: number;
  tournamentsWon: number;
  lastUpdated: string;
}

export interface TournamentStats {
  userId: string;
  username: string;
  avatar?: string;
  tournamentsPlayed: number;
  wins: number;
  finalTables: number;
  itmFinishes: number;
  totalPrizes: number;
  roi: number;
  biggestWin: number;
}

export interface HandResultForStats {
  handId: string;
  userId: string;
  isVoluntary: boolean;
  isPreflopRaise: boolean;
  wentToShowdown: boolean;
  wonAtShowdown: boolean;
  profit: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Compute the display value for a stats row given the metric. */
function metricValue(row: PlayerStatsRow, metric: LeaderboardMetric): number {
  const winnings = Number(row.total_winnings) || 0;
  const losses = Number(row.total_losses) || 0;
  switch (metric) {
    case 'hands_played':
      return Number(row.hands_played) || 0;
    // AUDIT 2026-08-19: vpip/pfr are stored as PERCENTAGES (measured range
    // 0.55..100, mean 40.4), not 0..1 fractions. The previous `* 10000 / 100`
    // multiplied by 100 and rendered a 40% VPIP as "4040%".
    case 'vpip':
      return Math.trunc((row.vpip || 0) * 100) / 100;
    case 'pfr':
      return Math.trunc((row.pfr || 0) * 100) / 100;
    case 'tournaments_won':
      return Number(row.tournaments_won) || 0;
    case 'roi':
      return losses > 0 ? Math.trunc(((winnings - losses) / losses) * 10000) / 100 : 0;
    case 'profit':
    default:
      return Math.trunc((winnings - losses) * 100) / 100;
  }
}

/** Attach usernames/avatars/tiers to raw stat rows. */
async function decorateWithProfiles(
  rows: PlayerStatsRow[],
  metric: LeaderboardMetric
): Promise<LeaderboardEntry[]> {
  const userIds = rows.map((s) => s.user_id);
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, username, avatar_url, level, tier')
    .in('id', userIds);

  const profileMap = new Map((profiles || []).map((p: ProfileRow) => [p.id, p]));

  return rows.map((row, index) => {
    const profile = profileMap.get(row.user_id) || ({} as ProfileRow);
    return {
      rank: index + 1,
      userId: row.user_id,
      username: profile.username || 'Player',
      avatar: profile.avatar_url,
      value: metricValue(row, metric),
      metric,
      change: Number(row.rank_change) || 0,
      hands: Number(row.hands_played) || 0,
      qualified: row.qualified !== false,
      isVIP: profile.tier === 'gold' || profile.tier === 'platinum' || profile.tier === 'diamond',
      vipTier: profile.tier || 'bronze',
      level: profile.level || 1,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const LeaderboardService = {
  /**
   * Get leaderboard for a club. Non-ratio metrics use the snapshot-delta RPC
   * (v2, with real rank_change) for every period including all_time. Ratio
   * metrics (vpip/pfr) have no meaningful period delta and query all-time
   * stats directly.
   */
  async getClubLeaderboard(
    clubId: string,
    metric: LeaderboardMetric = 'profit',
    period: LeaderboardPeriod = 'weekly',
    limit: number = 10
  ): Promise<LeaderboardEntry[]> {
    try {
      const resolvedClubId = await resolveClubUUID(clubId);
      const isRatio = metric === 'vpip' || metric === 'pfr';

      let statsData: PlayerStatsRow[] | null = null;

      if (!isRatio) {
        const { data, error } = await supabase.rpc('fn_club_leaderboard_period_v2', {
          p_club_id: resolvedClubId,
          p_metric: metric,
          p_period: period,
          p_limit: limit,
        });
        if (error) {
          reportError(error, 'LeaderboardService.getClubLeaderboard_v2');
        } else {
          statsData = data as PlayerStatsRow[];
        }
      }

      if (!statsData) {
        // Ratio metric, or v2 RPC failed: direct all-time query.
        const metricToColumn: Record<string, string> = {
          profit: 'total_winnings',
          hands_played: 'hands_played',
          vpip: 'vpip',
          pfr: 'pfr',
          tournaments_won: 'tournaments_won',
          roi: 'total_winnings',
        };
        const orderCol = metricToColumn[metric] || 'total_winnings';
        const { data, error } = await supabase
          .from('player_stats')
          .select(
            'user_id, hands_played, total_winnings, total_losses, total_rake, vpip, pfr, tournaments_played, tournaments_won'
          )
          .eq('club_id', resolvedClubId)
          .order(orderCol, { ascending: false })
          .limit(limit);
        if (error || !data) {
          reportError(error, 'LeaderboardService.getClubLeaderboard_direct');
          return [];
        }
        statsData = data as PlayerStatsRow[];
      }

      return await decorateWithProfiles(statsData, metric);
    } catch (err: unknown) {
      reportError(err, 'LeaderboardService.getClubLeaderboard_err');
      return [];
    }
  },

  /**
   * Get GLOBAL leaderboard across all clubs (per-user stats summed).
   * Supports profit, hands_played, tournaments_won, roi for every period
   * including all_time. Ratio metrics are per-club and not supported here.
   */
  async getGlobalLeaderboard(
    metric: LeaderboardMetric = 'profit',
    period: LeaderboardPeriod = 'weekly',
    limit: number = 50
  ): Promise<LeaderboardEntry[]> {
    try {
      if (metric === 'vpip' || metric === 'pfr') return [];
      const { data, error } = await supabase.rpc('fn_global_leaderboard_period', {
        p_metric: metric,
        p_period: period,
        p_limit: limit,
      });
      if (error || !data) {
        reportError(error, 'LeaderboardService.getGlobalLeaderboard');
        return [];
      }
      return await decorateWithProfiles(data as PlayerStatsRow[], metric);
    } catch (err: unknown) {
      reportError(err, 'LeaderboardService.getGlobalLeaderboard_err');
      return [];
    }
  },

  /**
   * Get leaderboard for a union (all member clubs combined)
   */
  /**
   * Get leaderboard for a union (all member clubs combined).
   *
   * AUDIT 2026-08-19: routed to fn_union_leaderboard_period_v2, which shares the
   * club board's semantics - hands from hands_dealt, ROI ordered by real ROI with
   * a volume qualifier, and a true rank_change. The v1 function ordered the ROI
   * board by profit and read the rakeback-owned hands_played column.
   */
  async getUnionLeaderboard(
    unionId: string,
    metric: LeaderboardMetric = 'profit',
    period: LeaderboardPeriod = 'weekly',
    limit: number = 20
  ): Promise<LeaderboardEntry[]> {
    try {
      // vpip/pfr are per-club ratios with no meaningful cross-club aggregate.
      if (metric === 'vpip' || metric === 'pfr') return [];
      const { data, error } = await supabase.rpc('fn_union_leaderboard_period_v2', {
        p_union_id: unionId,
        p_metric: metric,
        p_period: period,
        p_limit: limit,
      });
      if (error || !data) {
        reportError(error, 'LeaderboardService.getUnionLeaderboard');
        return [];
      }
      return await decorateWithProfiles(data as PlayerStatsRow[], metric);
    } catch (err: unknown) {
      reportError(err, 'LeaderboardService.getUnionLeaderboard_err');
      return [];
    }
  },

  /**
   * Get player's detailed stats
   */
  async getPlayerStats(userId: string, clubId?: string): Promise<PlayerStats | null> {
    let query = supabase
      .from('player_stats')
      .select(
        'user_id, club_id, hands_played, total_winnings, total_losses, total_rake, vpip, pfr, tournaments_played, tournaments_won, updated_at'
      )
      .eq('user_id', userId);

    if (clubId) {
      query = query.eq('club_id', await resolveClubUUID(clubId));
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      reportError(error, 'LeaderboardService.getPlayerStats_error');
      return null;
    }

    if (!data) return null;

    // NOTE: player_stats does not track three_bet, wtsd, wsd, agg_factor - these
    // advanced metrics have no real column and default to 0. ROI is derived from
    // real winnings/losses (invested chips).
    const winnings = data.total_winnings || 0;
    const losses = data.total_losses || 0;
    return {
      userId: data.user_id,
      handsPlayed: data.hands_played || 0,
      profit: winnings - losses,
      vpip: data.vpip || 0,
      pfr: data.pfr || 0,
      threeBet: 0,
      wtsd: 0,
      wsd: 0,
      aggFactor: 0,
      roi: losses > 0 ? ((winnings - losses) / losses) * 100 : 0,
      tournamentsPlayed: data.tournaments_played || 0,
      tournamentsWon: data.tournaments_won || 0,
      lastUpdated: data.updated_at,
    };
  },

  /**
   * Update player stats after a completed hand.
   * NOTE (2026-08-19): winnings/losses are now accumulated server-side (DB
   * trigger + engine contribution RPC). This client-side call remains only
   * for the profiles.total_hands_played counter and POY tracking.
   */
  async updateHandStats(
    result: HandResultForStats & { clubId?: string; clubName?: string }
  ): Promise<void> {
    const { error } = await retryAsync(
      () =>
        supabase.rpc('update_player_hand_stats', {
          p_user_id: result.userId,
          p_profit: result.profit,
          p_is_voluntary: result.isVoluntary,
          p_is_preflop_raise: result.isPreflopRaise,
          p_went_to_showdown: result.wentToShowdown,
          p_won_at_showdown: result.wonAtShowdown,
        }),
      3
    );

    if (error) {
      reportError(error, 'LeaderboardService.updateHandStats_error');
    }

    // Track for POY batched submission (cash games)
    if (result.clubId) {
      try {
        const { POYService } = await import('./POYService');
        POYService.trackHandResult({
          userId: result.userId,
          clubId: result.clubId,
          clubName: result.clubName,
          profit: result.profit,
        });
      } catch (_e: unknown) {
        // Silent fail for POY tracking
      }
    }
  },

  /**
   * Get user's rank on a specific club leaderboard.
   */
  async getUserRank(
    userId: string,
    clubId: string,
    metric: LeaderboardMetric = 'profit',
    period: LeaderboardPeriod = 'weekly'
  ): Promise<{ rank: number; total: number; value: number } | null> {
    try {
      const resolvedClubId = await resolveClubUUID(clubId);
      const isRatio = metric === 'vpip' || metric === 'pfr';

      if (!isRatio) {
        // fn_user_rank_period handles every period including all_time.
        const { data, error } = await supabase.rpc('fn_user_rank_period', {
          p_user_id: userId,
          p_club_id: resolvedClubId,
          p_metric: metric,
          p_period: period,
        });
        if (error || !data?.found) {
          if (error) reportError(error, 'LeaderboardService.getUserRank_period');
          return null;
        }
        return {
          rank: Number(data.rank || 0),
          total: Number(data.total || 0),
          value: Number(data.value || 0),
        };
      }

      // Ratio metrics: rank against the all-time direct ordering.
      const orderCol = metric === 'vpip' ? 'vpip' : 'pfr';
      const { data: allStats, error } = await supabase
        .from('player_stats')
        .select('user_id')
        .eq('club_id', resolvedClubId)
        .order(orderCol, { ascending: false })
        .limit(QUERY_LIMITS.BULK);

      if (error || !allStats) {
        reportError(error, 'LeaderboardService.getUserRank_error');
        return null;
      }

      const userIndex = allStats.findIndex((s: { user_id: string }) => s.user_id === userId);
      if (userIndex === -1) return null;

      return { rank: userIndex + 1, total: allStats.length, value: 0 };
    } catch (err: unknown) {
      reportError(
        err instanceof Error ? err.message : String(err),
        'LeaderboardService.getUserRank_error'
      );
      return null;
    }
  },

  /**
   * Get user's rank on the GLOBAL leaderboard (all clubs combined).
   */
  async getGlobalUserRank(
    userId: string,
    metric: LeaderboardMetric = 'profit',
    period: LeaderboardPeriod = 'weekly'
  ): Promise<{ rank: number; total: number; value: number } | null> {
    try {
      if (metric === 'vpip' || metric === 'pfr') return null;
      const { data, error } = await supabase.rpc('fn_user_rank_global_period', {
        p_user_id: userId,
        p_metric: metric,
        p_period: period,
      });
      if (error || !data?.found) {
        if (error) reportError(error, 'LeaderboardService.getGlobalUserRank');
        return null;
      }
      return {
        rank: Number(data.rank || 0),
        total: Number(data.total || 0),
        value: Number(data.value || 0),
      };
    } catch (err: unknown) {
      reportError(err, 'LeaderboardService.getGlobalUserRank_err');
      return null;
    }
  },

  /**
   * Get tournament stats for all players in a club
   */
  async getClubTournamentStats(clubId: string, limit: number = 50): Promise<TournamentStats[]> {
    try {
      const { data: playerResults, error: resultsError } = await supabase
        .from('tournament_players')
        .select(
          `
                    user_id,
                    username,
                    position,
                    prize,
                    tournaments!tournament_id (
                        id,
                        club_id,
                        buy_in_amount,
                        buy_in_fee
                    )
                `
        )
        .eq('tournaments.club_id', clubId)
        .in('status', ['eliminated', 'winner'])
        .limit(QUERY_LIMITS.AGGREGATE);

      if (resultsError || !playerResults) {
        reportError(resultsError, 'LeaderboardService.getClubTournamentStats');
        return [];
      }

      const statsMap = new Map<
        string,
        {
          username: string;
          userId: string;
          tournaments: Set<string>;
          wins: number;
          finalTables: number;
          itmFinishes: number;
          totalPrizes: number;
          totalBuyins: number;
          biggestWin: number;
        }
      >();

      playerResults.forEach((result: any) => {
        const userId = result.user_id as string;
        const tourn = result.tournaments;
        if (!tourn) return;

        if (!statsMap.has(userId)) {
          statsMap.set(userId, {
            username: result.username || 'Player',
            userId,
            tournaments: new Set(),
            wins: 0,
            finalTables: 0,
            itmFinishes: 0,
            totalPrizes: 0,
            totalBuyins: 0,
            biggestWin: 0,
          });
        }

        const stats = statsMap.get(userId)!;

        if (tourn.club_id === clubId) {
          const buyin = tourn.buy_in_amount || 0;
          const fee = tourn.buy_in_fee || 0;
          stats.tournaments.add(tourn.id);
          stats.totalBuyins += buyin + fee;
        }

        if (result.position === 1) stats.wins++;
        if (result.position && result.position <= 9) stats.finalTables++;
        if (result.prize && result.prize > 0) stats.itmFinishes++;

        const prize = result.prize || 0;
        stats.totalPrizes += prize;
        stats.biggestWin = Math.max(stats.biggestWin, prize);
      });

      const statsArray = Array.from(statsMap.values()).map((stats) => ({
        userId: stats.userId,
        username: stats.username,
        tournamentsPlayed: stats.tournaments.size,
        wins: stats.wins,
        finalTables: stats.finalTables,
        itmFinishes: stats.itmFinishes,
        totalPrizes: stats.totalPrizes,
        roi:
          stats.totalBuyins > 0
            ? ((stats.totalPrizes - stats.totalBuyins) / stats.totalBuyins) * 100
            : 0,
        biggestWin: stats.biggestWin,
      }));

      const userIds = statsArray.map((s) => s.userId);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, username, avatar_url')
        .in('id', userIds);

      const profileMap = new Map((profiles || []).map((p: ProfileRow) => [p.id, p]));

      return statsArray
        .map((stats) => ({
          ...stats,
          avatar: profileMap.get(stats.userId)?.avatar_url,
          username: profileMap.get(stats.userId)?.username || stats.username,
        }))
        .sort((a, b) => b.totalPrizes - a.totalPrizes)
        .slice(0, limit);
    } catch (err: unknown) {
      reportError(err, 'LeaderboardService.getClubTournamentStats');
      return [];
    }
  },

  /**
   * Get period date boundaries
   */
  getPeriodBoundaries(period: LeaderboardPeriod): { start: Date; end: Date } {
    const now = new Date();
    const end = new Date(now);
    let start: Date;

    switch (period) {
      case 'daily':
        start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'weekly': {
        const dayOfWeek = now.getDay();
        start = new Date(now);
        start.setDate(now.getDate() - dayOfWeek);
        start.setHours(0, 0, 0, 0);
        break;
      }
      case 'monthly':
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'all_time':
        start = new Date(0);
        break;
    }

    return { start, end };
  },
};

export default LeaderboardService;
