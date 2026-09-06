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
import { resolveVipStatus } from '../utils/vipStatus';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { QUERY_LIMITS } from '../lib/constants';
import {
  playerDisplayName,
  PLAYER_NAME_COLUMNS,
  type NameableProfile,
} from '../utils/playerDisplayName';
import { reportError } from '../utils/errorReporter';
import { uuid } from '../utils/uuid';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface PlayerStatsRow {
  user_id: string;
  hands_played: number;
  /** True per-seat count. The RPCs return it AS hands_played; the direct-query
   *  fallback selects it explicitly so both paths report the same number. */
  hands_dealt?: number;
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
  sum_big_blind?: number;
  rank?: number;
  total_ranked?: number;
  baseline_date?: string;
}

interface ProfileRow extends NameableProfile {
  id: string;
  username: string;
  avatar_url?: string;
  level?: number;
  /* The three columns VIP actually lives in. `tier` is gone from this row:
     it is 'Newcomer' on every profile and was the source of both leaderboard
     VIP defects (2026-09-05). */
  is_vip?: boolean | null;
  vip_tier?: string | null;
  vip_expires_at?: string | null;
}

export type LeaderboardPeriod = 'daily' | 'weekly' | 'monthly' | 'all_time';

export interface LeaderboardPeriodWindow {
  period: LeaderboardPeriod;
  period_offset: number;
  timezone: 'UTC';
  start_date: string;
  /** Exclusive period boundary. Closed periods read the snapshot at this date. */
  end_date: string;
  start_at: string;
  end_at: string;
  is_current: boolean;
  label: string;
}
export type LeaderboardMetric =
  | 'profit'
  | 'hands_played'
  | 'vpip'
  | 'pfr'
  | 'roi'
  | 'bb100'
  | 'tournaments_won';

export interface LeaderboardPrize {
  rank: number;
  amount: number;
}

export type LeaderboardPrizePlanKey = 'balanced' | 'top_heavy' | 'even' | 'custom';

export interface LeaderboardSettings {
  club_id: string;
  club_name: string;
  union_id: string | null;
  union_name: string | null;
  funding_owner_type: 'union' | 'club';
  funding_source: 'union_promo_wallet' | 'club_promo_balance';
  funding_label: string;
  available_balance: number | null;
  wallet_balance: number | null;
  committed_balance: number | null;
  current_program_commitment: number | null;
  other_program_commitments: number | null;
  available_uncommitted_balance: number | null;
  publication_capacity: number | null;
  committed_club_count: number | null;
  funding_status: 'not_published' | 'disabled' | 'funded' | 'underfunded';
  can_manage: boolean;
  setup_complete: boolean;
  rewards_enabled: boolean;
  payout_currency: 'chips';
  payout_metric: Extract<LeaderboardMetric, 'profit' | 'hands_played' | 'tournaments_won' | 'roi'>;
  weekly_prizes: LeaderboardPrize[];
  monthly_prizes: LeaderboardPrize[];
  suggestion_key: LeaderboardPrizePlanKey;
  program_version: number;
  program_hash: string | null;
  program_status: 'not_published' | 'published';
  weekly_effective_from: string | null;
  monthly_effective_from: string | null;
  published_at: string | null;
  program_funding_owner_type: 'union' | 'club' | null;
  program_funding_union_id: string | null;
  program_funding_label: string | null;
  setup_completed_at: string | null;
  updated_at: string | null;
}

export interface LeaderboardRewardContext {
  club_id: string;
  club_name: string;
  union_id: string | null;
  union_name: string | null;
  funding_owner_type: 'union' | 'club';
  funding_source: 'union_promo_wallet' | 'club_promo_balance';
  setup_complete: boolean;
  rewards_enabled: boolean;
}

export interface LeaderboardRewardPlan {
  program_id: string;
  program_version: number;
  program_hash: string;
  status: 'published';
  rewards_enabled: boolean;
  period: 'weekly' | 'monthly';
  period_start: string;
  payout_metric: Extract<LeaderboardMetric, 'profit' | 'hands_played' | 'tournaments_won' | 'roi'>;
  prizes: LeaderboardPrize[];
  funding_owner_type: 'union' | 'club';
  funding_union_id: string | null;
  published_at: string;
}

export interface LeaderboardPayout {
  id: string;
  club_id: string;
  period: string;
  metric: string;
  start_date: string;
  end_date: string;
  user_id: string;
  rank: number;
  payout_amount: number;
  payout_currency: string;
  awarded_at: string;
}

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
  /** False when the row fails the rate-metric volume qualifier; such rows sort last. */
  qualified?: boolean;
  /** Size of the ranked population, so the client can page without re-deriving it. */
  totalRanked?: number;
  /**
   * The snapshot date the period delta was measured from. Surfaced because the
   * daily snapshot job has missed a day before (2026-08-09): on a miss these
   * functions fall back to an older snapshot and "This Week" silently becomes a
   * longer window. Showing the real date makes that visible.
   */
  baselineDate?: string;
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

/**
 * The RPC's row shape. Numerics arrive from PostgREST as strings, so every
 * numeric field is widened here and coerced at the mapping site rather than
 * trusted — a string in `totalPrizes` sorts and formats as garbage, silently.
 */
interface TournamentStatsRow {
  userId: string;
  username: string | null;
  avatar: string | null;
  tournamentsPlayed: number | string | null;
  wins: number | string | null;
  finalTables: number | string | null;
  itmFinishes: number | string | null;
  totalPrizes: number | string | null;
  roi: number | string | null;
  biggestWin: number | string | null;
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

/**
 * Hands for a row, preferring the true per-seat counter.
 *
 * player_stats.hands_played is owned by RakebackSettlerService and only counts
 * RAKED hands, per settled row rather than per seat - measured at 13.4% of
 * reality. hands_dealt is the real count. The RPCs already return hands_dealt
 * in the hands_played slot; the direct-query fallback selects hands_dealt
 * explicitly, so this prefers it and falls back only if it is absent.
 */
function handsOf(row: PlayerStatsRow): number {
  return Number(row.hands_dealt ?? row.hands_played) || 0;
}

/** Compute the display value for a stats row given the metric. */
function metricValue(row: PlayerStatsRow, metric: LeaderboardMetric): number {
  const winnings = Number(row.total_winnings) || 0;
  const losses = Number(row.total_losses) || 0;
  switch (metric) {
    case 'hands_played':
      return handsOf(row);
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
    case 'bb100': {
      // Stake-normalised win rate: big blinds won per 100 hands.
      const bb = Number(row.sum_big_blind) || 0;
      return bb > 0 ? Math.trunc(((winnings - losses) / bb) * 10000) / 100 : 0;
    }
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
    .select(
      `id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url, level, is_vip, vip_tier, vip_expires_at`
    )
    .in('id', userIds);

  const profileMap = new Map((profiles || []).map((p: ProfileRow) => [p.id, p]));

  return rows.map((row, index) => {
    const profile = profileMap.get(row.user_id) || ({} as ProfileRow);
    return {
      // Rank comes from the RPC so it stays correct on pages after the first.
      rank: row.rank != null ? Number(row.rank) : index + 1,
      userId: row.user_id,
      username: playerDisplayName(profile),
      avatar: profile.avatar_url,
      value: metricValue(row, metric),
      metric,
      change: Number(row.rank_change) || 0,
      hands: handsOf(row),
      qualified: row.qualified !== false,
      totalRanked: row.total_ranked != null ? Number(row.total_ranked) : undefined,
      baselineDate: row.baseline_date,
      /**
       * 2026-09-05: this asked `profile.tier === 'gold' | 'platinum' |
       * 'diamond'`. `profiles.tier` is 'Newcomer' on all 1,310 rows, so the
       * VIP badge on the leaderboard was structurally unreachable - 0 of
       * 1,032 real VIP members ever saw it. And `vipTier: profile.tier`
       * handed PlayerAvatar the string 'Newcomer', which its
       * `vipTier !== 'bronze'` gate reads as truthy, so it rendered a
       * `tier-Newcomer` ring for EVERY player - a class with no rule in
       * PlayerAvatar.css, i.e. an invisible element on every row. One column
       * produced both a badge nobody could earn and a ring everybody got.
       */
      isVIP: resolveVipStatus(profile) !== 'none',
      vipTier: 'bronze',
      level: profile.level || 1,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const LeaderboardService = {
  /**
   * Load the one canonical calendar window used by rankings, prize display and
   * eventual settlement. The database owns these boundaries so a browser's
   * locale or daylight-saving transition can never change a leaderboard.
   */
  async getPeriodWindow(
    period: LeaderboardPeriod,
    periodOffset: number = 0
  ): Promise<LeaderboardPeriodWindow> {
    const { data, error } = await supabase.rpc('fn_leaderboard_period_window', {
      p_period: period,
      p_period_offset: periodOffset,
    });
    if (error) {
      reportError(error, 'LeaderboardService.getPeriodWindow');
      throw error;
    }

    const row = (Array.isArray(data) ? data[0] : data) as Partial<LeaderboardPeriodWindow> | null;
    if (
      !row ||
      row.period !== period ||
      row.period_offset !== periodOffset ||
      row.timezone !== 'UTC' ||
      typeof row.start_date !== 'string' ||
      typeof row.end_date !== 'string' ||
      typeof row.start_at !== 'string' ||
      typeof row.end_at !== 'string' ||
      typeof row.is_current !== 'boolean' ||
      typeof row.label !== 'string'
    ) {
      throw new Error('Leaderboard Period Window Returned Invalid Data');
    }
    return row as LeaderboardPeriodWindow;
  },

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
    limit: number = 10,
    offset: number = 0,
    periodOffset: number = 0,
    strict: boolean = false
  ): Promise<LeaderboardEntry[]> {
    try {
      const resolvedClubId = await resolveClubUUID(clubId);
      const isRatio = metric === 'vpip' || metric === 'pfr';

      let statsData: PlayerStatsRow[] | null = null;

      if (!isRatio) {
        let data, error;
        if (periodOffset < 0) {
          const window = await this.getPeriodWindow(period, periodOffset);
          const result = await supabase.rpc('fn_club_leaderboard_by_dates', {
            p_club_id: resolvedClubId,
            p_metric: metric,
            p_start_date: window.start_date,
            p_end_date: window.end_date,
            p_limit: limit,
            p_offset: offset,
          });
          data = result.data;
          error = result.error;
        } else {
          const result = await supabase.rpc('fn_club_leaderboard_period_v2', {
            p_club_id: resolvedClubId,
            p_metric: metric,
            p_period: period,
            p_limit: limit,
            p_offset: offset,
          });
          data = result.data;
          error = result.error;
        }
        if (error) {
          reportError(error, 'LeaderboardService.getClubLeaderboard_v2');
          // The page opts into strict mode because a period-specific failure
          // must never fall through to the direct all-time query and render
          // those rows under a Daily/Weekly/Monthly label.
          if (strict) throw error;
        } else {
          statsData = data as PlayerStatsRow[];
        }
      }

      if (!statsData) {
        // Ratio metric, or v2 RPC failed: direct all-time query.
        const metricToColumn: Record<string, string> = {
          profit: 'total_winnings',
          hands_played: 'hands_dealt',
          vpip: 'vpip',
          pfr: 'pfr',
          tournaments_won: 'tournaments_won',
          roi: 'total_winnings',
        };
        const orderCol = metricToColumn[metric] || 'total_winnings';
        const { data, error } = await supabase
          .from('player_stats')
          .select(
            'user_id, hands_played, hands_dealt, total_winnings, total_losses, total_rake, vpip, pfr, tournaments_played, tournaments_won'
          )
          .eq('club_id', resolvedClubId)
          .order(orderCol, { ascending: false })
          .range(offset, offset + limit - 1);
        if (error || !data) {
          reportError(error, 'LeaderboardService.getClubLeaderboard_direct');
          if (strict) throw error || new Error('Club leaderboard returned no data');
          return [];
        }
        statsData = data as PlayerStatsRow[];
      }

      return await decorateWithProfiles(statsData, metric);
    } catch (err: unknown) {
      reportError(err, 'LeaderboardService.getClubLeaderboard_err');
      if (strict) throw err;
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
    limit: number = 50,
    offset: number = 0,
    periodOffset: number = 0,
    strict: boolean = false
  ): Promise<LeaderboardEntry[]> {
    try {
      if (metric === 'vpip' || metric === 'pfr') return [];
      let data, error;
      if (periodOffset < 0) {
        const window = await this.getPeriodWindow(period, periodOffset);
        const result = await supabase.rpc('fn_global_leaderboard_by_dates', {
          p_metric: metric,
          p_start_date: window.start_date,
          p_end_date: window.end_date,
          p_limit: limit,
          p_offset: offset,
        });
        data = result.data;
        error = result.error;
      } else {
        const result = await supabase.rpc('fn_global_leaderboard_period', {
          p_metric: metric,
          p_period: period,
          p_limit: limit,
          p_offset: offset,
        });
        data = result.data;
        error = result.error;
      }
      if (error || !data) {
        reportError(error, 'LeaderboardService.getGlobalLeaderboard');
        if (strict) throw error || new Error('Global leaderboard returned no data');
        return [];
      }
      return await decorateWithProfiles(data as PlayerStatsRow[], metric);
    } catch (err: unknown) {
      reportError(err, 'LeaderboardService.getGlobalLeaderboard_err');
      if (strict) throw err;
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
      } catch {
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
    period: LeaderboardPeriod = 'weekly',
    periodOffset: number = 0
  ): Promise<{ rank: number; total: number; value: number } | null> {
    try {
      const resolvedClubId = await resolveClubUUID(clubId);
      const isRatio = metric === 'vpip' || metric === 'pfr';

      if (!isRatio) {
        let data, error;
        if (periodOffset < 0) {
          const window = await this.getPeriodWindow(period, periodOffset);
          const result = await supabase.rpc('fn_user_rank_by_dates', {
            p_user_id: userId,
            p_club_id: resolvedClubId,
            p_metric: metric,
            p_start_date: window.start_date,
            p_end_date: window.end_date,
          });
          data = result.data;
          error = result.error;
        } else {
          const result = await supabase.rpc('fn_user_rank_period', {
            p_user_id: userId,
            p_club_id: resolvedClubId,
            p_metric: metric,
            p_period: period,
          });
          data = result.data;
          error = result.error;
        }
        const rankData = (Array.isArray(data) ? data[0] : data) as {
          rank?: number;
          total?: number;
          value?: number;
          found?: boolean;
        } | null;
        if (error || !rankData?.found) {
          if (error) reportError(error, 'LeaderboardService.getUserRank_period');
          return null;
        }
        return {
          rank: Number(rankData.rank || 0),
          total: Number(rankData.total || 0),
          value: Number(rankData.value || 0),
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
    period: LeaderboardPeriod = 'weekly',
    periodOffset: number = 0
  ): Promise<{ rank: number; total: number; value: number } | null> {
    try {
      if (metric === 'vpip' || metric === 'pfr') return null;
      let data, error;
      if (periodOffset < 0) {
        const window = await this.getPeriodWindow(period, periodOffset);
        const result = await supabase.rpc('fn_user_rank_global_by_dates', {
          p_user_id: userId,
          p_metric: metric,
          p_start_date: window.start_date,
          p_end_date: window.end_date,
        });
        data = result.data;
        error = result.error;
      } else {
        const result = await supabase.rpc('fn_user_rank_global_period', {
          p_user_id: userId,
          p_metric: metric,
          p_period: period,
        });
        data = result.data;
        error = result.error;
      }
      const rankData = (Array.isArray(data) ? data[0] : data) as {
        rank?: number;
        total?: number;
        value?: number;
        found?: boolean;
      } | null;
      if (error || !rankData?.found) {
        if (error) reportError(error, 'LeaderboardService.getGlobalUserRank');
        return null;
      }
      return {
        rank: Number(rankData.rank || 0),
        total: Number(rankData.total || 0),
        value: Number(rankData.value || 0),
      };
    } catch (err: unknown) {
      reportError(err, 'LeaderboardService.getGlobalUserRank_err');
      return null;
    }
  },

  /**
   * Get tournament stats for all players in a club
   */
  async getClubTournamentStats(
    clubId: string,
    limit: number = 50,
    offset: number = 0,
    strict: boolean = false
  ): Promise<TournamentStats[]> {
    try {
      /* Server-side first. The fallback below aggregates in the browser from
         raw rows capped at QUERY_LIMITS.AGGREGATE, and every club with results
         is past that cap — 21,116 / 19,241 / 17,842 rows measured 2026-08-21 —
         with no ORDER BY before the limit, so it ranks an arbitrary half of a
         club's history. On SHARK CLUB that put the true #1 at #5, the true #2
         at #28, the true #3 at #116 with $0, and dropped the true #10 entirely.

         This RPC shipped once before, on 2026-08-21, and was lost: a merge
         reverted this method's body while the migration that created the
         function sat unapplied in the repo. Hence the fallback — if the
         function is ever missing again, the leaderboard degrades to the old
         approximation instead of going blank — and hence the assertion in
         tests/shipped-invariants.test.ts that this call still exists. */
      const { data: rpcRows, error: rpcError } = await supabase.rpc('fn_club_tournament_stats', {
        p_club_id: clubId,
        p_limit: limit,
        p_offset: offset,
      });

      if (rpcError) {
        reportError(rpcError, 'LeaderboardService.getClubTournamentStats_rpc');
        // The browser fallback is deliberately retained for non-strict legacy
        // callers, but it is capped and therefore cannot truthfully replace the
        // server aggregate on the production leaderboard page.
        if (strict) throw rpcError;
      } else if (Array.isArray(rpcRows)) {
        return (rpcRows as TournamentStatsRow[]).map((row) => ({
          userId: row.userId,
          username: row.username || 'Player',
          avatar: row.avatar ?? undefined,
          tournamentsPlayed: Number(row.tournamentsPlayed || 0),
          wins: Number(row.wins || 0),
          finalTables: Number(row.finalTables || 0),
          itmFinishes: Number(row.itmFinishes || 0),
          totalPrizes: Number(row.totalPrizes || 0),
          roi: Number(row.roi || 0),
          biggestWin: Number(row.biggestWin || 0),
        }));
      } else if (strict) {
        throw new Error('Tournament leaderboard RPC returned invalid data');
      }

      const { data: playerResults, error: resultsError } = await supabase
        .from('tournament_players')
        .select(
          `
                    user_id,
                    username,
                    position,
                    prize,
                    tournaments!inner (
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
        if (strict) throw resultsError || new Error('Tournament leaderboard returned no data');
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
        .select(`id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url`)
        .in('id', userIds);

      const profileMap = new Map((profiles || []).map((p: ProfileRow) => [p.id, p]));

      return statsArray
        .map((stats) => ({
          ...stats,
          avatar: profileMap.get(stats.userId)?.avatar_url,
          username: profileMap.has(stats.userId)
            ? playerDisplayName(profileMap.get(stats.userId))
            : stats.username,
        }))
        .sort((a, b) => b.totalPrizes - a.totalPrizes || a.userId.localeCompare(b.userId))
        .slice(offset, offset + limit);
    } catch (err: unknown) {
      reportError(err, 'LeaderboardService.getClubTournamentStats');
      if (strict) throw err;
      return [];
    }
  },

  async getManageableRewardContexts(strict: boolean = false): Promise<LeaderboardRewardContext[]> {
    try {
      const { data, error } = await supabase.rpc('fn_leaderboard_reward_contexts');
      if (error) throw error;
      return (data as LeaderboardRewardContext[]) || [];
    } catch (err) {
      reportError(err, 'LeaderboardService.getManageableRewardContexts');
      if (strict) throw err;
      return [];
    }
  },

  async getLeaderboardRewardSetup(clubId: string): Promise<LeaderboardSettings> {
    const { data, error } = await supabase.rpc('fn_get_leaderboard_reward_setup', {
      p_club_id: clubId,
    });
    if (error) {
      reportError(error, 'LeaderboardService.getLeaderboardRewardSetup');
      throw error;
    }
    if (!data || typeof data !== 'object') throw new Error('Prize Setup Returned No Data');
    return data as LeaderboardSettings;
  },

  async getLeaderboardRewardPlan(
    clubId: string,
    period: 'weekly' | 'monthly',
    periodStart: string
  ): Promise<LeaderboardRewardPlan | null> {
    const { data, error } = await supabase.rpc('fn_get_leaderboard_reward_plan', {
      p_club_id: clubId,
      p_period: period,
      p_period_start: periodStart,
    });
    if (error) {
      reportError(error, 'LeaderboardService.getLeaderboardRewardPlan');
      throw error;
    }
    if (data == null) return null;
    if (
      typeof data !== 'object' ||
      !('program_version' in data) ||
      !('program_hash' in data) ||
      !('prizes' in data) ||
      !Array.isArray(data.prizes)
    ) {
      throw new Error('Leaderboard Reward Program Returned Invalid Data');
    }
    return data as unknown as LeaderboardRewardPlan;
  },

  async saveLeaderboardRewardSetup(
    clubId: string,
    setup: Pick<
      LeaderboardSettings,
      | 'rewards_enabled'
      | 'payout_metric'
      | 'weekly_prizes'
      | 'monthly_prizes'
      | 'suggestion_key'
      | 'program_version'
    >
  ): Promise<LeaderboardSettings> {
    // One immutable intent key lives outside the retry closure. If PostgREST
    // commits and its response is lost, the retry replays the same publication
    // instead of creating another version or reporting a false stale conflict.
    const operationId = uuid();
    const { data } = await retryAsync(async () => {
      const response = await supabase.rpc('fn_save_leaderboard_reward_setup', {
        p_club_id: clubId,
        p_rewards_enabled: setup.rewards_enabled,
        p_metric: setup.payout_metric,
        p_weekly_prizes: setup.weekly_prizes,
        p_monthly_prizes: setup.monthly_prizes,
        p_suggestion_key: setup.suggestion_key,
        p_expected_version: setup.program_version,
        p_operation_id: operationId,
      });
      if (response.error) {
        reportError(response.error, 'LeaderboardService.saveLeaderboardRewardSetup');
        throw new Error(response.error.message || 'Prize Program Could Not Be Published');
      }
      return response;
    });
    if (!data || typeof data !== 'object') throw new Error('Prize Setup Could Not Be Saved');
    return data as LeaderboardSettings;
  },

  async getPayoutsForPeriod(
    clubId: string,
    period: string,
    metric: string,
    startDate: string
  ): Promise<LeaderboardPayout[]> {
    try {
      const { data, error } = await supabase
        .from('leaderboard_payouts')
        .select('*')
        .eq('club_id', clubId)
        .eq('period', period)
        .eq('metric', metric)
        .eq('start_date', startDate);
      if (error) throw error;
      return (data as LeaderboardPayout[]) || [];
    } catch (err) {
      reportError(err, 'LeaderboardService.getPayoutsForPeriod');
      return [];
    }
  },

  async getUserTrophies(userId: string): Promise<LeaderboardPayout[]> {
    try {
      const { data, error } = await supabase
        .from('leaderboard_payouts')
        .select('*')
        .eq('user_id', userId)
        .order('awarded_at', { ascending: false });
      if (error) throw error;
      return (data as LeaderboardPayout[]) || [];
    } catch (err) {
      reportError(err, 'LeaderboardService.getUserTrophies');
      return [];
    }
  },
};

export default LeaderboardService;
