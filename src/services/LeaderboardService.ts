/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LEADERBOARD SERVICE — Player Rankings & Stats
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Manages club and union leaderboards with:
 * - Daily, weekly, monthly, and all-time rankings
 * - Multiple metrics: profit, hands played, VPIP, PFR, ROI

 */

import { supabase } from '../lib/supabase';
import { VIP_GOLD_LIMITS } from './VIPService';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { QUERY_LIMITS } from '../lib/constants';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

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
  change: number; // Position change from previous period
  isVIP?: boolean;
  vipTier?: string;
  level?: number;
}

export interface PlayerStats {
  userId: string;
  handsPlayed: number;
  profit: number;
  vpip: number; // Voluntarily Put $ In Pot %
  pfr: number; // Pre-Flop Raise %
  threeBet: number; // 3-Bet %
  wtsd: number; // Went To Showdown %
  wsd: number; // Won $ at Showdown %
  aggFactor: number; // Aggression Factor
  roi: number; // Tournament ROI %
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
  isVoluntary: boolean; // Did they put money in voluntarily?
  isPreflopRaise: boolean; // Did they raise preflop?
  wentToShowdown: boolean;
  wonAtShowdown: boolean;
  profit: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const LeaderboardService = {
  /**
   * Get leaderboard for a club
   */
  async getClubLeaderboard(
    clubId: string,
    metric: LeaderboardMetric = 'profit',
    _period: LeaderboardPeriod = 'weekly',
    limit: number = 10
  ): Promise<LeaderboardEntry[]> {
    try {
      // Direct query — player_stats has: total_winnings, total_losses, hands_played, vpip, pfr, tournaments_played, tournaments_won
      const metricToColumn: Record<string, string> = {
        profit: 'total_winnings',
        hands_played: 'hands_played',
        vpip: 'vpip',
        pfr: 'pfr',
        tournaments_won: 'tournaments_won',
        roi: 'total_winnings', // Sort by winnings as proxy for ROI
      };
      const orderCol = metricToColumn[metric] || 'total_winnings';

      const { data: statsData, error: statsError } = await supabase
        .from('player_stats')
        .select(
          'user_id, hands_played, total_winnings, total_losses, total_rake, vpip, pfr, tournaments_played, tournaments_won'
        )
        .eq('club_id', await resolveClubUUID(clubId))
        .order(orderCol, { ascending: false })
        .limit(limit);

      if (statsError || !statsData) {
        console.error('LeaderboardService.getClubLeaderboard stats error:', statsError);
        return [];
      }

      // Get usernames for the user IDs
      const userIds = statsData.map((s: any) => s.user_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, username, avatar_url, level, tier')
        .in('id', userIds);

      const profileMap = new Map((profiles || []).map((p: any) => [p.id, p]));

      return statsData.map((row: any, index: number) => {
        const profile = profileMap.get(row.user_id) || ({} as any);
        let value = 0;
        if (metric === 'profit')
          value = Math.trunc(((row.total_winnings || 0) - (row.total_losses || 0)) * 100) / 100;
        else if (metric === 'hands_played') value = row.hands_played || 0;
        else if (metric === 'vpip') value = Math.trunc((row.vpip || 0) * 10000) / 100;
        else if (metric === 'pfr') value = Math.trunc((row.pfr || 0) * 10000) / 100;
        else if (metric === 'tournaments_won') value = row.tournaments_won || 0;
        else if (metric === 'roi') {
          const winnings = row.total_winnings || 0;
          const losses = row.total_losses || 0;
          value = losses > 0 ? Math.trunc(((winnings - losses) / losses) * 10000) / 100 : 0;
        } else
          value = Math.trunc(((row.total_winnings || 0) - (row.total_losses || 0)) * 100) / 100;

        return {
          rank: index + 1,
          userId: row.user_id,
          username: profile.username || 'Player',
          avatar: profile.avatar_url,
          value,
          metric,
          change: 0,
          isVIP:
            profile.tier === 'gold' || profile.tier === 'platinum' || profile.tier === 'diamond',
          vipTier: profile.tier || 'bronze',
          level: profile.level || 1,
        };
      });
    } catch (err: unknown) {
      console.error('LeaderboardService.getClubLeaderboard error:', err);
      return [];
    }
  },

  /**
   * Get leaderboard for a union (all member clubs combined)
   */
  async getUnionLeaderboard(
    unionId: string,
    metric: LeaderboardMetric = 'profit',
    _period: LeaderboardPeriod = 'weekly',
    limit: number = 20
  ): Promise<LeaderboardEntry[]> {
    try {
      // Get clubs in this union
      const { data: unionClubs } = await supabase
        .from('union_clubs')
        .select('club_id')
        .eq('union_id', unionId);

      if (!unionClubs || unionClubs.length === 0) return [];

      const clubIds = unionClubs.map((uc: any) => uc.club_id);
      const metricToColumn: Record<string, string> = {
        profit: 'total_winnings',
        hands_played: 'hands_played',
        vpip: 'vpip',
        pfr: 'pfr',
        tournaments_won: 'tournaments_won',
        roi: 'total_winnings',
      };
      const orderCol = metricToColumn[metric] || 'total_winnings';

      const { data: statsData, error: statsError } = await supabase
        .from('player_stats')
        .select(
          'user_id, hands_played, total_winnings, total_losses, vpip, pfr, tournaments_played, tournaments_won'
        )
        .in('club_id', clubIds)
        .order(orderCol, { ascending: false })
        .limit(limit);

      if (statsError || !statsData) return [];

      const userIds = statsData.map((s: any) => s.user_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, username, avatar_url, level, tier')
        .in('id', userIds);

      const profileMap = new Map((profiles || []).map((p: any) => [p.id, p]));

      return statsData.map((row: any, index: number) => {
        const profile = profileMap.get(row.user_id) || ({} as any);
        let value = 0;
        if (metric === 'profit')
          value = Math.trunc(((row.total_winnings || 0) - (row.total_losses || 0)) * 100) / 100;
        else if (metric === 'hands_played') value = row.hands_played || 0;
        else if (metric === 'vpip') value = Math.trunc((row.vpip || 0) * 10000) / 100;
        else if (metric === 'pfr') value = Math.trunc((row.pfr || 0) * 10000) / 100;
        else if (metric === 'tournaments_won') value = row.tournaments_won || 0;
        else if (metric === 'roi') {
          const winnings = row.total_winnings || 0;
          const losses = row.total_losses || 0;
          value = losses > 0 ? Math.trunc(((winnings - losses) / losses) * 10000) / 100 : 0;
        } else
          value = Math.trunc(((row.total_winnings || 0) - (row.total_losses || 0)) * 100) / 100;

        return {
          rank: index + 1,
          userId: row.user_id,
          username: profile.username || 'Player',
          avatar: profile.avatar_url,
          value,
          metric,
          change: 0,
          isVIP:
            profile.tier === 'gold' || profile.tier === 'platinum' || profile.tier === 'diamond',
          vipTier: profile.tier || 'bronze',
          level: profile.level || 1,
        };
      });
    } catch (err: unknown) {
      console.error('LeaderboardService.getUnionLeaderboard error:', err);
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
        'user_id, club_id, hands_played, total_winnings, total_losses, total_rake, vpip, pfr, three_bet, wtsd, wsd, agg_factor, tournament_roi, tournaments_played, tournaments_won, updated_at'
      )
      .eq('user_id', userId);

    if (clubId) {
      query = query.eq('club_id', await resolveClubUUID(clubId));
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      console.error('LeaderboardService.getPlayerStats error:', error);
      return null;
    }

    if (!data) return null;

    return {
      userId: data.user_id,
      handsPlayed: data.hands_played || 0,
      profit: (data.total_winnings || 0) - (data.total_losses || 0),
      vpip: data.vpip || 0,
      pfr: data.pfr || 0,
      threeBet: data.three_bet || 0,
      wtsd: data.wtsd || 0,
      wsd: data.wsd || 0,
      aggFactor: data.agg_factor || 0,
      roi: data.tournament_roi || 0,
      tournamentsPlayed: data.tournaments_played || 0,
      tournamentsWon: data.tournaments_won || 0,
      lastUpdated: data.updated_at,
    };
  },

  /**
   * Update player stats after a completed hand
   * Called by HandController after each hand
   */
  async updateHandStats(
    result: HandResultForStats & { clubId?: string; clubName?: string }
  ): Promise<void> {
    // Use upsert to atomically update stat counters
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
      console.error('LeaderboardService.updateHandStats error:', error);
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
      } catch (e: unknown) {
        // Silent fail for POY tracking
      }
    }
  },

  /**
   * Get user's rank on a specific leaderboard
   */
  async getUserRank(
    userId: string,
    clubId: string,
    metric: LeaderboardMetric = 'profit',
    _period: LeaderboardPeriod = 'weekly'
  ): Promise<{ rank: number; total: number } | null> {
    try {
      const metricToColumn: Record<string, string> = {
        profit: 'total_winnings',
        hands_played: 'hands_played',
        vpip: 'vpip',
        pfr: 'pfr',
        tournaments_won: 'tournaments_won',
        roi: 'total_winnings',
      };
      const orderCol = metricToColumn[metric] || 'total_winnings';

      const { data: allStats, error } = await supabase
        .from('player_stats')
        .select(
          'user_id, total_winnings, total_losses, hands_played, vpip, pfr, tournaments_played, tournaments_won'
        )
        .eq('club_id', await resolveClubUUID(clubId))
        .order(orderCol, { ascending: false })
        .limit(QUERY_LIMITS.BULK);

      if (error || !allStats) {
        console.error('LeaderboardService.getUserRank error:', error);
        return null;
      }

      const userIndex = allStats.findIndex((s: any) => s.user_id === userId);
      if (userIndex === -1) return null;

      return {
        rank: userIndex + 1,
        total: allStats.length,
      };
    } catch (err: unknown) {
      console.error('LeaderboardService.getUserRank error:', err);
      return null;
    }
  },

  /**
   * Get tournament stats for all players in a club
   */
  async getClubTournamentStats(clubId: string, limit: number = 50): Promise<TournamentStats[]> {
    try {
      // Query tournament_players for all completed tournaments in this club
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
        console.error('LeaderboardService.getClubTournamentStats error:', resultsError);
        return [];
      }

      // Group and aggregate stats by user
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
        const userId = result.user_id;
        // Supabase returns a single object for many-to-one joins, not an array
        const tourn = result.tournaments as any;

        // Skip if no tournament data (filtered out by club_id)
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

        // Process the tournament data (single object, not array)
        if (tourn.club_id === clubId) {
          const buyin = tourn.buy_in_amount || 0;
          const fee = tourn.buy_in_fee || 0;
          stats.tournaments.add(tourn.id);
          stats.totalBuyins += buyin + fee;
        }

        // Check position and prize
        if (result.position === 1) stats.wins++;
        if (result.position && result.position <= 9) stats.finalTables++;
        if (result.prize && result.prize > 0) stats.itmFinishes++;

        const prize = result.prize || 0;
        stats.totalPrizes += prize;
        stats.biggestWin = Math.max(stats.biggestWin, prize);
      });

      // Convert to array and calculate ROI
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

      // Get usernames and avatars from profiles
      const userIds = statsArray.map((s) => s.userId);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, username, avatar_url')
        .in('id', userIds);

      const profileMap = new Map((profiles || []).map((p: any) => [p.id, p]));

      // Merge profile data and sort by totalPrizes descending
      return statsArray
        .map((stats) => ({
          ...stats,
          avatar: profileMap.get(stats.userId)?.avatar_url,
          username: profileMap.get(stats.userId)?.username || stats.username,
        }))
        .sort((a, b) => b.totalPrizes - a.totalPrizes)
        .slice(0, limit);
    } catch (err: unknown) {
      console.error('LeaderboardService.getClubTournamentStats error:', err);
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
