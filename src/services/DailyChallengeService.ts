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
import { STORAGE_KEYS } from '../lib/storage';

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
    icon: '👀',
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
    icon: '🔥',
  },
  {
    id: 'weekly_wins_50',
    name: 'Weekly Winner',
    description: 'Win 50 hands this week',
    type: 'hands_won',
    requirement: 50,
    chipReward: 1500,
    icon: '👑',
  },
  {
    id: 'weekly_tourneys_10',
    name: 'Tournament Specialist',
    description: 'Play 10 tournaments this week',
    type: 'tournaments_played',
    requirement: 10,
    chipReward: 2000,
    icon: '🏆',
  },
  {
    id: 'weekly_showdowns_20',
    name: 'Showdown Machine',
    description: 'Reach 20 showdowns this week',
    type: 'showdowns',
    requirement: 20,
    chipReward: 800,
    icon: '👀',
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
    icon: '🌋',
  },
  {
    id: 'monthly_wins_250',
    name: 'Monthly Dominator',
    description: 'Win 250 hands this month',
    type: 'hands_won',
    requirement: 250,
    chipReward: 10000,
    icon: '💎',
  },
  {
    id: 'monthly_tourneys_50',
    name: 'Tournament Master',
    description: 'Play 50 tournaments this month',
    type: 'tournaments_played',
    requirement: 50,
    chipReward: 15000,
    icon: '🚀',
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
    if (existErr)
      console.warn('[DailyChallenge] getTodaysChallenges fetch error:', existErr.message);

    if (existing && existing.length > 0) {
      return existing.map(this.mapToUserChallenge);
    }

    // Assign new challenges
    const todaysChallenges = this.selectDailyChallenges(3);
    const inserts = todaysChallenges.map((c) => ({
      user_id: userId,
      challenge_id: c.id,
      assigned_date: today,
      progress: 0,
      completed: false,
    }));

    const { error: insertErr } = await supabase.from('user_daily_challenges').insert(inserts);
    if (insertErr) console.error('[DailyChallenge] Failed to assign daily challenges:', insertErr);

    // Return with challenge data
    return todaysChallenges.map((c, i) => ({
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
    if (wkErr) console.warn('[DailyChallenge] getWeeklyChallenges fetch error:', wkErr.message);

    if (existing && existing.length > 0) {
      return existing.map((row) => ({ ...this.mapToUserChallenge(row), tier: 'weekly' as const }));
    }

    // Assign new weekly challenges
    const weeklyChallenges = this.selectChallenges(WEEKLY_CHALLENGE_POOL, 3);
    const inserts = weeklyChallenges.map((c) => ({
      user_id: userId,
      challenge_id: c.id,
      assigned_date: weekKey,
      progress: 0,
      completed: false,
    }));

    const { error: insertErr } = await supabase.from('user_daily_challenges').insert(inserts);
    if (insertErr) console.error('[DailyChallenge] Failed to assign weekly challenges:', insertErr);

    return weeklyChallenges.map((c, i) => ({
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
    if (moErr) console.warn('[DailyChallenge] getMonthlyChallenges fetch error:', moErr.message);

    if (existing && existing.length > 0) {
      return existing.map((row) => ({ ...this.mapToUserChallenge(row), tier: 'monthly' as const }));
    }

    // Assign new monthly challenges
    const monthlyChallenges = this.selectChallenges(MONTHLY_CHALLENGE_POOL, 2);
    const inserts = monthlyChallenges.map((c) => ({
      user_id: userId,
      challenge_id: c.id,
      assigned_date: monthKey,
      progress: 0,
      completed: false,
    }));

    const { error: insertErr } = await supabase.from('user_daily_challenges').insert(inserts);
    if (insertErr)
      console.error('[DailyChallenge] Failed to assign monthly challenges:', insertErr);

    return monthlyChallenges.map((c, i) => ({
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
    if (chErr) console.warn('[DailyChallenge] updateProgress fetch error:', chErr.message);

    if (!challenges) return { completed };

    for (const uc of challenges) {
      // Find challenge from all pools
      const challenge =
        CHALLENGE_POOL.find((c) => c.id === uc.challenge_id) ||
        WEEKLY_CHALLENGE_POOL.find((c) => c.id === uc.challenge_id) ||
        MONTHLY_CHALLENGE_POOL.find((c) => c.id === uc.challenge_id);

      if (!challenge || challenge.type !== type) continue;

      const newProgress = Math.min(uc.progress + amount, challenge.requirement);
      const isComplete = newProgress >= challenge.requirement;

      const { error: progErr } = await supabase
        .from('user_daily_challenges')
        .update({
          progress: newProgress,
          completed: isComplete,
          completed_at: isComplete ? new Date().toISOString() : null,
        })
        .eq('id', uc.id);
      if (progErr) {
        console.error('[DailyChallenge] Progress update failed:', progErr);
        continue;
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
    const { error } = await retryAsync(
      () =>
        supabase.rpc('claim_daily_challenge', {
          p_user_id: userId,
          p_challenge_row_id: challengeRowId,
          p_reward_amount: rewardAmount,
        }),
      3
    );

    if (error) {
      console.error('[DailyChallenge] Failed to claim:', error);
      throw new Error(error.message);
    }

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
  }> {
    const { data, error: statErr } = await supabase
      .from('user_daily_challenges')
      .select('challenge_id, completed, assigned_date')
      .eq('user_id', userId)
      .eq('completed', true)
      .limit(500);
    if (statErr) console.warn('[DailyChallenge] getStats error:', statErr.message);

    if (!data) {
      return { totalCompleted: 0, currentStreak: 0, totalChipsEarned: 0 };
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
    const dates = [...new Set(data.map((d) => d.assigned_date))].sort().reverse();
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

    return { totalCompleted, currentStreak, totalChipsEarned };
  }

  /**
   * Emit push notification trigger for daily reset
   */
  public emitDailyResetReminder(): void {
    try {
      const today = this.getTodayKey();
      const lastReminder = localStorage.getItem(STORAGE_KEYS.LAST_DAILY_RESET_REMINDER);

      if (lastReminder !== today) {
        masterBus.emit('DAILY_RESET_AVAILABLE', { date: today });
        localStorage.setItem('last_daily_reset_reminder', today);
      }
    } catch (e: unknown) {
      // Ignore localStorage errors (e.g. strict privacy settings)
    }
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

  private selectChallenges(pool: DailyChallenge[], count: number): DailyChallenge[] {
    const shuffled = [...pool].sort(() => 0.5 - Math.random());
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
    const date = new Date(dateStr);
    date.setDate(date.getDate() - days);
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
        icon: '❓',
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
