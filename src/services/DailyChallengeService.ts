/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 📆 DAILY CHALLENGE SERVICE — Rotating Challenge Engine
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Provides rotating daily challenges that refresh each day.
 * Players can complete challenges for chips and other rewards.
 */

import { supabase } from '../lib/supabase';
import { WalletService } from './WalletService';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ChallengeType =
  | 'hands_played'
  | 'hands_won'
  | 'showdowns'
  | 'tournaments_played'
  | 'login_streak'
  | 'rakeback_earned'
  | 'friends_added';

export interface DailyChallenge {
  id: string;
  name: string;
  description: string;
  type: ChallengeType;
  requirement: number;
  chipReward: number;
  icon: string;
}

export interface UserDailyChallenge {
  id: string;
  challengeId: string;
  userId: string;
  progress: number;
  completed: boolean;
  claimed: boolean;
  completedAt?: string;
  challenge: DailyChallenge;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHALLENGE POOL
// ═══════════════════════════════════════════════════════════════════════════════

export const CHALLENGE_POOL: DailyChallenge[] = [
  // Easy Challenges (daily grind)
  {
    id: 'hands_10',
    name: 'Warm Up',
    description: 'Play 10 hands today',
    type: 'hands_played',
    requirement: 10,
    chipReward: 50,
    icon: '',
  },
  {
    id: 'hands_25',
    name: 'Getting Serious',
    description: 'Play 25 hands today',
    type: 'hands_played',
    requirement: 25,
    chipReward: 100,
    icon: '',
  },
  {
    id: 'hands_50',
    name: 'Grinder',
    description: 'Play 50 hands today',
    type: 'hands_played',
    requirement: 50,
    chipReward: 200,
    icon: '',
  },

  // Win Challenges
  {
    id: 'wins_3',
    name: 'Triple Threat',
    description: 'Win 3 hands today',
    type: 'hands_won',
    requirement: 3,
    chipReward: 75,
    icon: '',
  },
  {
    id: 'wins_5',
    name: 'High Five',
    description: 'Win 5 hands today',
    type: 'hands_won',
    requirement: 5,
    chipReward: 150,
    icon: '✋',
  },
  {
    id: 'wins_10',
    name: 'Ten Bagger',
    description: 'Win 10 hands today',
    type: 'hands_won',
    requirement: 10,
    chipReward: 300,
    icon: '',
  },

  // Showdown Challenges
  {
    id: 'showdown_3',
    name: 'Show Your Cards',
    description: 'Reach 3 showdowns today',
    type: 'showdowns',
    requirement: 3,
    chipReward: 60,
    icon: '',
  },
  {
    id: 'showdown_5',
    name: 'Showdown King',
    description: 'Reach 5 showdowns today',
    type: 'showdowns',
    requirement: 5,
    chipReward: 120,
    icon: '',
  },

  // Tournament Challenges
  {
    id: 'tourney_1',
    name: 'Tournament Time',
    description: 'Play 1 tournament today',
    type: 'tournaments_played',
    requirement: 1,
    chipReward: 100,
    icon: '',
  },
  {
    id: 'tourney_3',
    name: 'Tournament Regular',
    description: 'Play 3 tournaments today',
    type: 'tournaments_played',
    requirement: 3,
    chipReward: 300,
    icon: '',
  },

  // Social Challenges
  {
    id: 'friend_1',
    name: 'Make a Friend',
    description: 'Add 1 friend today',
    type: 'friends_added',
    requirement: 1,
    chipReward: 50,
    icon: '',
  },
];

export const WEEKLY_CHALLENGE_POOL: DailyChallenge[] = [
  {
    id: 'weekly_hands_250',
    name: 'Weekly Grinder',
    description: 'Play 250 hands this week',
    type: 'hands_played',
    requirement: 250,
    chipReward: 1000,
    icon: '',
  },
  {
    id: 'weekly_wins_50',
    name: 'Weekly Winner',
    description: 'Win 50 hands this week',
    type: 'hands_won',
    requirement: 50,
    chipReward: 1500,
    icon: '',
  },
  {
    id: 'weekly_tourneys_10',
    name: 'Tournament Specialist',
    description: 'Play 10 tournaments this week',
    type: 'tournaments_played',
    requirement: 10,
    chipReward: 2000,
    icon: '',
  },
  {
    id: 'weekly_showdowns_20',
    name: 'Showdown Machine',
    description: 'Reach 20 showdowns this week',
    type: 'showdowns',
    requirement: 20,
    chipReward: 800,
    icon: '',
  },
];

export const MONTHLY_CHALLENGE_POOL: DailyChallenge[] = [
  {
    id: 'monthly_hands_1000',
    name: 'Monthly Marathon',
    description: 'Play 1,000 hands this month',
    type: 'hands_played',
    requirement: 1000,
    chipReward: 5000,
    icon: '',
  },
  {
    id: 'monthly_wins_250',
    name: 'Monthly Dominator',
    description: 'Win 250 hands this month',
    type: 'hands_won',
    requirement: 250,
    chipReward: 10000,
    icon: '',
  },
  {
    id: 'monthly_tourneys_50',
    name: 'Tournament Master',
    description: 'Play 50 tournaments this month',
    type: 'tournaments_played',
    requirement: 50,
    chipReward: 15000,
    icon: '',
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class DailyChallengeServiceClass {
  /**
   * Get today's challenges for a user
   * Assigns 3 random challenges if not already assigned
   */
  async getTodaysChallenges(userId: string): Promise<UserDailyChallenge[]> {
    const today = this.getTodayKey();

    // Check if challenges already assigned
    const { data: existing, error: existErr } = await supabase
      .from('user_daily_challenges')
      .select('*')
      .eq('user_id', userId)
      .eq('assigned_date', today);
    if (existErr) reportError(existErr, 'DailyChallengeService.getTodaysChallenges_fetch_error');

    if (existing && existing.length > 0) {
      return existing.map(this.mapToUserChallenge);
    }

    // Assign new challenges — use ignoreDuplicates to handle TOCTOU race:
    // If two tabs call this simultaneously, both SELECT returns empty, both INSERT.
    // With ignoreDuplicates, the second insert silently skips existing rows.
    const todaysChallenges = this.selectDailyChallenges(3);
    const inserts = todaysChallenges.map((c) => ({
      user_id: userId,
      challenge_id: c.id,
      assigned_date: today,
      progress: 0,
      completed: false,
    }));

    const { error: insertErr } = await supabase.from('user_daily_challenges').upsert(inserts, {
      onConflict: 'user_id,challenge_id,assigned_date',
      ignoreDuplicates: true,
    });
    if (insertErr)
      reportError(insertErr, 'DailyChallengeService.Failed_to_assign_daily_challenges');

    // Always re-fetch from DB to get canonical rows (handles race condition correctly)
    const { data: canonical } = await supabase
      .from('user_daily_challenges')
      .select('*')
      .eq('user_id', userId)
      .eq('assigned_date', today);

    if (canonical && canonical.length > 0) {
      return canonical.map(this.mapToUserChallenge);
    }

    // Final fallback: return in-memory data if DB is unreachable
    return todaysChallenges.map((c) => ({
      id: `${userId}-${c.id}-${today}`,
      challengeId: c.id,
      userId,
      progress: 0,
      completed: false,
      claimed: false,
      tier: 'daily' as const,
      challenge: c,
    }));
  }

  /**
   * Get this week's challenges for a user
   */
  async getWeeklyChallenges(userId: string): Promise<(UserDailyChallenge & { tier: 'weekly' })[]> {
    const weekKey = this.getWeekKey();

    const { data: existing, error: wkErr } = await supabase
      .from('user_daily_challenges')
      .select('*')
      .eq('user_id', userId)
      .eq('assigned_date', weekKey);
    if (wkErr) reportError(wkErr, 'DailyChallengeService.getWeeklyChallenges_fetch_error');

    if (existing && existing.length > 0) {
      return existing.map((row) => ({ ...this.mapToUserChallenge(row), tier: 'weekly' as const }));
    }

    // Assign new weekly challenges — ignoreDuplicates handles TOCTOU race
    const weeklyChallenges = this.selectChallenges(WEEKLY_CHALLENGE_POOL, 3, weekKey);
    const inserts = weeklyChallenges.map((c) => ({
      user_id: userId,
      challenge_id: c.id,
      assigned_date: weekKey,
      progress: 0,
      completed: false,
    }));

    const { error: insertErr } = await supabase.from('user_daily_challenges').upsert(inserts, {
      onConflict: 'user_id,challenge_id,assigned_date',
      ignoreDuplicates: true,
    });
    if (insertErr)
      reportError(insertErr, 'DailyChallengeService.Failed_to_assign_weekly_challenges');

    // Re-fetch canonical rows from DB
    const { data: canonical } = await supabase
      .from('user_daily_challenges')
      .select('*')
      .eq('user_id', userId)
      .eq('assigned_date', weekKey);

    if (canonical && canonical.length > 0) {
      return canonical.map((row) => ({ ...this.mapToUserChallenge(row), tier: 'weekly' as const }));
    }

    return weeklyChallenges.map((c) => ({
      id: `${userId}-${c.id}-${weekKey}`,
      challengeId: c.id,
      userId,
      progress: 0,
      completed: false,
      claimed: false,
      tier: 'weekly' as const,
      challenge: c,
    }));
  }

  /**
   * Get this month's challenges for a user
   */
  async getMonthlyChallenges(
    userId: string
  ): Promise<(UserDailyChallenge & { tier: 'monthly' })[]> {
    const monthKey = this.getMonthKey();

    const { data: existing, error: moErr } = await supabase
      .from('user_daily_challenges')
      .select('*')
      .eq('user_id', userId)
      .eq('assigned_date', monthKey);
    if (moErr) reportError(moErr, 'DailyChallengeService.getMonthlyChallenges_fetch_error');

    if (existing && existing.length > 0) {
      return existing.map((row) => ({ ...this.mapToUserChallenge(row), tier: 'monthly' as const }));
    }

    // Assign new monthly challenges — ignoreDuplicates handles TOCTOU race
    const monthlyChallenges = this.selectChallenges(MONTHLY_CHALLENGE_POOL, 2, monthKey);
    const inserts = monthlyChallenges.map((c) => ({
      user_id: userId,
      challenge_id: c.id,
      assigned_date: monthKey,
      progress: 0,
      completed: false,
    }));

    const { error: insertErr } = await supabase.from('user_daily_challenges').upsert(inserts, {
      onConflict: 'user_id,challenge_id,assigned_date',
      ignoreDuplicates: true,
    });
    if (insertErr)
      reportError(insertErr, 'DailyChallengeService.Failed_to_assign_monthly_challenges');

    // Re-fetch canonical rows from DB
    const { data: canonical } = await supabase
      .from('user_daily_challenges')
      .select('*')
      .eq('user_id', userId)
      .eq('assigned_date', monthKey);

    if (canonical && canonical.length > 0) {
      return canonical.map((row) => ({
        ...this.mapToUserChallenge(row),
        tier: 'monthly' as const,
      }));
    }

    return monthlyChallenges.map((c) => ({
      id: `${userId}-${c.id}-${monthKey}`,
      challengeId: c.id,
      userId,
      progress: 0,
      completed: false,
      claimed: false,
      tier: 'monthly' as const,
      challenge: c,
    }));
  }

  /**
   * Update progress on a challenge type
   * Called by AchievementTriggerService or directly from game events
   */
  async updateProgress(
    userId: string,
    type: ChallengeType,
    amount: number = 1
  ): Promise<{ completed: UserDailyChallenge[] }> {
    const today = this.getTodayKey();
    const weekKey = this.getWeekKey();
    const monthKey = this.getMonthKey();
    const completed: UserDailyChallenge[] = [];

    // Get today's/week's/month's active challenges of this type
    const { data: challenges, error: chErr } = await supabase
      .from('user_daily_challenges')
      .select('*')
      .eq('user_id', userId)
      .in('assigned_date', [today, weekKey, monthKey])
      .eq('completed', false);
    if (chErr) reportError(chErr, 'DailyChallengeService.updateProgress_fetch_error');

    if (!challenges) return { completed };

    for (const uc of challenges) {
      // Find challenge from all pools
      const challenge =
        CHALLENGE_POOL.find((c) => c.id === uc.challenge_id) ||
        WEEKLY_CHALLENGE_POOL.find((c) => c.id === uc.challenge_id) ||
        MONTHLY_CHALLENGE_POOL.find((c) => c.id === uc.challenge_id);

      if (!challenge || challenge.type !== type) continue;

      // Try atomic RPC first (eliminates read-then-write race condition)
      let newProgress: number;
      let isComplete: boolean;
      const { data: rpcResult, error: rpcErr } = await supabase.rpc(
        'increment_challenge_progress',
        {
          p_user_id: userId,
          p_challenge_row_id: uc.id,
          p_amount: amount,
          p_requirement: challenge.requirement,
        }
      );

      if (!rpcErr && rpcResult?.updated) {
        // Atomic RPC succeeded
        newProgress = rpcResult.progress;
        isComplete = rpcResult.completed;
      } else {
        // Fallback: direct UPDATE (for environments where RPC not yet deployed)
        if (rpcErr && !rpcErr.message.includes('Could not find')) {
          console.warn('[DailyChallenge] RPC error (using fallback):', rpcErr.message);
        }
        newProgress = Math.min(uc.progress + amount, challenge.requirement);
        isComplete = newProgress >= challenge.requirement;

        const { error: progErr } = await supabase
          .from('user_daily_challenges')
          .update({
            progress: newProgress,
            completed: isComplete,
            completed_at: isComplete ? new Date().toISOString() : null,
          })
          .eq('id', uc.id);
        if (progErr) {
          reportError(progErr, 'DailyChallengeService.Progress_update_failed');
          continue;
        }
      }

      if (isComplete) {
        completed.push({
          id: uc.id,
          challengeId: uc.challenge_id,
          userId,
          progress: newProgress,
          completed: true,
          claimed: false,
          completedAt: new Date().toISOString(),
          challenge,
        });
      }
    }

    return { completed };
  }

  /**
   * Claim standard chip reward directly from UI
   */
  async claimChallenge(
    userId: string,
    challengeRowId: string,
    rewardAmount: number
  ): Promise<boolean> {
    // retryAsync retries transient network errors (fetch/timeout/503)
    // Inner throw converts Supabase { error } responses into thrown errors
    await retryAsync(async () => {
      const result = await supabase.rpc('claim_daily_challenge', {
        p_user_id: userId,
        p_challenge_row_id: challengeRowId,
        p_reward_amount: rewardAmount,
      });
      if (result.error) {
        reportError(result.error, 'DailyChallengeService.RPC_claim_error');
        throw new Error(result.error.message);
      }
      return result;
    }, 3);

    try {
      await WalletService.logTransaction(
        userId,
        'PLAYER',
        rewardAmount,
        'credit',
        'bonus',
        `Manual Claim: Daily Challenge Reward`
      );
    } catch (logErr) {
      console.warn('[DailyChallenge] Transaction log failed (claim still valid):', logErr);
    }
    masterBus.emit('BALANCE_UPDATED', { source: 'daily_challenge_claim', userId });
    return true;
  }

  /**
   * Get challenge completion stats for a user
   */
  async getStats(userId: string): Promise<{
    totalCompleted: number;
    currentStreak: number;
    totalChipsEarned: number;
    nextMilestone: number;
    milestoneReward: number;
  }> {
    const { data, error: statErr } = await supabase
      .from('user_daily_challenges')
      .select('challenge_id, completed, assigned_date')
      .eq('user_id', userId)
      .eq('completed', true)
      .limit(QUERY_LIMITS.MODERATE);
    if (statErr) reportError(statErr, 'DailyChallengeService.getStats_error');

    if (!data) {
      return {
        totalCompleted: 0,
        currentStreak: 0,
        totalChipsEarned: 0,
        nextMilestone: 7,
        milestoneReward: 500,
      };
    }

    const totalCompleted = data.length;
    let totalChipsEarned = 0;

    for (const uc of data) {
      const challenge =
        CHALLENGE_POOL.find((c) => c.id === uc.challenge_id) ||
        WEEKLY_CHALLENGE_POOL.find((c) => c.id === uc.challenge_id) ||
        MONTHLY_CHALLENGE_POOL.find((c) => c.id === uc.challenge_id);
      if (challenge) {
        totalChipsEarned += challenge.chipReward;
      }
    }

    // Calculate streak (consecutive days with at least 1 completion)
    // CRITICAL: Filter to DAILY keys only. Weekly keys start with "W" and
    // monthly keys start with "M" — these are NOT valid dates and would
    // produce Invalid Date from subtractDays(), silently breaking the streak.
    const dailyDates = data
      .map((d) => d.assigned_date)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)); // Only YYYY-MM-DD
    const dates = [...new Set(dailyDates)].sort().reverse();
    let currentStreak = 0;
    const today = this.getTodayKey();

    for (const date of dates) {
      const expectedDate = this.subtractDays(today, currentStreak);
      if (date === expectedDate) {
        currentStreak++;
      } else {
        break;
      }
    }

    // Dynamic streak milestones — tiered rewards escalate with longer streaks
    const MILESTONES = [
      { days: 7, reward: 500 },
      { days: 14, reward: 1500 },
      { days: 30, reward: 5000 },
      { days: 60, reward: 15000 },
      { days: 100, reward: 50000 },
    ];
    const nextMilestoneEntry =
      MILESTONES.find((m) => m.days > currentStreak) || MILESTONES[MILESTONES.length - 1];
    const nextMilestone = nextMilestoneEntry.days;
    const milestoneReward = nextMilestoneEntry.reward;

    return { totalCompleted, currentStreak, totalChipsEarned, nextMilestone, milestoneReward };
  }

  // emitDailyResetReminder removed — was dead code (never called from any file)

  /**
   * Batch fetch all challenge tiers for a user in a single call.
   * Reduces boilerplate in ProfilePage and DailyChallengesWidget.
   */
  async getAllChallenges(userId: string): Promise<{
    daily: UserDailyChallenge[];
    weekly: (UserDailyChallenge & { tier: 'weekly' })[];
    monthly: (UserDailyChallenge & { tier: 'monthly' })[];
  }> {
    const [daily, weekly, monthly] = await Promise.all([
      this.getTodaysChallenges(userId),
      this.getWeeklyChallenges(userId),
      this.getMonthlyChallenges(userId),
    ]);
    return { daily, weekly, monthly };
  }

  /**
   * Select random challenges for today
   */
  private selectDailyChallenges(count: number): DailyChallenge[] {
    // Use date-based seed for consistent challenges across all users
    const seed = this.getTodayKey().replace(/-/g, '');
    const shuffled = [...CHALLENGE_POOL].sort((a, b) => {
      const hashA = this.simpleHash(seed + a.id);
      const hashB = this.simpleHash(seed + b.id);
      return hashA - hashB;
    });
    return shuffled.slice(0, count);
  }

  private selectChallenges(
    pool: DailyChallenge[],
    count: number,
    periodKey: string
  ): DailyChallenge[] {
    // Use period-specific seed for DETERMINISTIC selection — prevents race conditions
    // when multiple tabs/instances call this simultaneously before DB insert.
    // Each pool (weekly/monthly) gets a unique seed prefix to avoid collisions.
    const seed = periodKey.replace(/[^a-zA-Z0-9]/g, '');
    const shuffled = [...pool].sort((a, b) => {
      const hashA = this.simpleHash(seed + a.id);
      const hashB = this.simpleHash(seed + b.id);
      return hashA - hashB;
    });
    return shuffled.slice(0, count);
  }

  /**
   * Get today's date key (YYYY-MM-DD)
   */
  private getTodayKey(): string {
    return new Date().toISOString().split('T')[0];
  }

  private getWeekKey(): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - d.getUTCDay() + 1); // Monday
    return `W${d.toISOString().split('T')[0]}`;
  }

  private getMonthKey(): string {
    const d = new Date();
    return `M${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
  }

  /**
   * Subtract days from a date
   */
  private subtractDays(dateStr: string, days: number): string {
    // MUST use UTC operations — getTodayKey() returns UTC date (via toISOString()),
    // so streak calculation must also use UTC to avoid timezone boundary mismatches.
    const date = new Date(dateStr + 'T00:00:00Z'); // Force UTC parse
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString().split('T')[0];
  }

  /**
   * Simple hash for seeded randomization
   */
  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }

  /**
   * Map database row to typed object
   */
  private mapToUserChallenge(row: any): UserDailyChallenge {
    const challenge = CHALLENGE_POOL.find((c) => c.id === row.challenge_id) ||
      WEEKLY_CHALLENGE_POOL.find((c) => c.id === row.challenge_id) ||
      MONTHLY_CHALLENGE_POOL.find((c) => c.id === row.challenge_id) || {
        id: row.challenge_id,
        name: 'Unknown',
        description: '',
        type: 'hands_played' as ChallengeType,
        requirement: 0,
        chipReward: 0,
        icon: '?',
      };

    return {
      id: row.id,
      challengeId: row.challenge_id,
      userId: row.user_id,
      progress: row.progress,
      completed: row.completed,
      claimed: row.claimed || false,
      completedAt: row.completed_at,
      challenge,
    };
  }
}

export const dailyChallengeService = new DailyChallengeServiceClass();
export default dailyChallengeService;
