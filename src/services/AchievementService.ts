/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ACHIEVEMENT SERVICE — Gamification & Badge System
 * Manages player achievements, badges, and unlock tracking
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import { retryAsync } from '../utils/retryAsync';
import { QUERY_LIMITS } from '../lib/constants';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type AchievementCategory =
  | 'hands'
  | 'wins'
  | 'social'
  | 'financial'
  | 'special'
  | 'tournament';
export type AchievementRarity = 'common' | 'rare' | 'epic' | 'legendary';

export interface Achievement {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: AchievementCategory;
  rarity: AchievementRarity;
  requirement: number;
  chipReward?: number;
  hidden?: boolean;
}

export interface UserAchievement {
  id: string;
  achievementId: string;
  userId: string;
  progress: number;
  unlockedAt?: string;
  achievement?: Achievement;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PREDEFINED ACHIEVEMENTS
// ═══════════════════════════════════════════════════════════════════════════════

export const ACHIEVEMENTS: Achievement[] = [
  // Hands Played
  {
    id: 'hands_100',
    name: 'Getting Started',
    description: 'Play 100 hands',
    icon: '',
    category: 'hands',
    rarity: 'common',
    requirement: 100,
    chipReward: 0,
  },
  {
    id: 'hands_1000',
    name: 'Regular',
    description: 'Play 1,000 hands',
    icon: '',
    category: 'hands',
    rarity: 'rare',
    requirement: 1000,
    chipReward: 0,
  },
  {
    id: 'hands_10000',
    name: 'Grinder',
    description: 'Play 10,000 hands',
    icon: '',
    category: 'hands',
    rarity: 'epic',
    requirement: 10000,
    chipReward: 0,
  },
  {
    id: 'hands_100000',
    name: 'Professional',
    description: 'Play 100,000 hands',
    icon: '',
    category: 'hands',
    rarity: 'legendary',
    requirement: 100000,
    chipReward: 0,
  },

  // Wins
  {
    id: 'wins_10',
    name: 'First Blood',
    description: 'Win 10 hands',
    icon: '✊',
    category: 'wins',
    rarity: 'common',
    requirement: 10,
    chipReward: 0,
  },
  {
    id: 'wins_100',
    name: 'Winner',
    description: 'Win 100 hands',
    icon: '',
    category: 'wins',
    rarity: 'rare',
    requirement: 100,
    chipReward: 0,
  },
  {
    id: 'wins_1000',
    name: 'Dominator',
    description: 'Win 1,000 hands',
    icon: '',
    category: 'wins',
    rarity: 'epic',
    requirement: 1000,
    chipReward: 0,
  },

  // Social
  {
    id: 'friends_5',
    name: 'Social Butterfly',
    description: 'Add 5 friends',
    icon: '🦋',
    category: 'social',
    rarity: 'common',
    requirement: 5,
    chipReward: 0,
  },
  {
    id: 'friends_25',
    name: 'Popular',
    description: 'Add 25 friends',
    icon: '',
    category: 'social',
    rarity: 'rare',
    requirement: 25,
    chipReward: 0,
  },
  {
    id: 'clubs_3',
    name: 'Club Hopper',
    description: 'Join 3 clubs',
    icon: '',
    category: 'social',
    rarity: 'common',
    requirement: 3,
    chipReward: 0,
  },

  // Financial
  {
    id: 'profit_1000',
    name: 'In the Green',
    description: 'Profit 1,000 chips',
    icon: '',
    category: 'financial',
    rarity: 'rare',
    requirement: 1000,
    chipReward: 0,
  },
  {
    id: 'profit_10000',
    name: 'High Roller',
    description: 'Profit 10,000 chips',
    icon: '',
    category: 'financial',
    rarity: 'epic',
    requirement: 10000,
    chipReward: 0,
  },
  {
    id: 'biggest_pot_500',
    name: 'Big Pot',
    description: 'Win a 500+ chip pot',
    icon: '',
    category: 'financial',
    rarity: 'rare',
    requirement: 500,
    chipReward: 0,
  },

  // Tournament
  {
    id: 'tourney_win_1',
    name: 'Champion',
    description: 'Win a tournament',
    icon: '',
    category: 'tournament',
    rarity: 'epic',
    requirement: 1,
    chipReward: 0,
  },
  {
    id: 'tourney_top3_10',
    name: 'Consistent',
    description: 'Finish top 3 in 10 tournaments',
    icon: '🎖️',
    category: 'tournament',
    rarity: 'rare',
    requirement: 10,
    chipReward: 0,
  },
  {
    id: 'tourney_played_50',
    name: 'Tournament Regular',
    description: 'Play 50 tournaments',
    icon: '',
    category: 'tournament',
    rarity: 'rare',
    requirement: 50,
    chipReward: 0,
  },

  // Special
  {
    id: 'royal_flush',
    name: 'Royal Flush',
    description: 'Hit a Royal Flush',
    icon: '',
    category: 'special',
    rarity: 'legendary',
    requirement: 1,
    chipReward: 500,
  },
  {
    id: 'straight_flush',
    name: 'Straight Flush',
    description: 'Hit a Straight Flush',
    icon: '🌊',
    category: 'special',
    rarity: 'epic',
    requirement: 1,
    chipReward: 0,
  },
  {
    id: 'quads',
    name: 'Four of a Kind',
    description: 'Hit Quads',
    icon: '4️⃣',
    category: 'special',
    rarity: 'rare',
    requirement: 1,
    chipReward: 0,
  },
  {
    id: 'bad_beat',
    name: 'Bad Beat Survivor',
    description: 'Lose with quads or better',
    icon: '💔',
    category: 'special',
    rarity: 'epic',
    requirement: 1,
    chipReward: 0,
    hidden: true,
  },

  // Streak
  {
    id: 'streak_7',
    name: 'Weekly Warrior',
    description: 'Log in 7 days in a row',
    icon: '🔥',
    category: 'special',
    rarity: 'common',
    requirement: 7,
    chipReward: 0,
  },
  {
    id: 'streak_30',
    name: 'Monthly Grinder',
    description: 'Log in 30 days in a row',
    icon: '📅',
    category: 'special',
    rarity: 'rare',
    requirement: 30,
    chipReward: 100,
  },
  {
    id: 'streak_100',
    name: 'Centurion',
    description: 'Log in 100 days in a row',
    icon: '💯',
    category: 'special',
    rarity: 'legendary',
    requirement: 100,
    chipReward: 500,
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// ACHIEVEMENT SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class AchievementServiceClass {
  // ─────────────────────────────────────────────────────────────────────────────
  // Get Achievements
  // ─────────────────────────────────────────────────────────────────────────────

  getAll(): Achievement[] {
    return ACHIEVEMENTS.filter((a) => !a.hidden);
  }

  getByCategory(category: AchievementCategory): Achievement[] {
    return ACHIEVEMENTS.filter((a) => a.category === category && !a.hidden);
  }

  getById(id: string): Achievement | undefined {
    return ACHIEVEMENTS.find((a) => a.id === id);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // User Progress
  // ─────────────────────────────────────────────────────────────────────────────

  async getUserAchievements(userId: string): Promise<UserAchievement[]> {
    const { data, error } = await supabase
      .from('user_achievements')
      .select('id, achievement_id, user_id, progress, unlocked_at')
      .eq('user_id', userId)
      .limit(QUERY_LIMITS.MODERATE);

    if (error) {
      console.error('[AchievementService] Error fetching achievements:', error);
      return [];
    }

    // Merge with achievement definitions
    return (data || []).map((ua) => ({
      id: ua.id,
      achievementId: ua.achievement_id,
      userId: ua.user_id,
      progress: ua.progress,
      unlockedAt: ua.unlocked_at,
      achievement: this.getById(ua.achievement_id),
    }));
  }

  async getProgress(userId: string, achievementId: string): Promise<number> {
    const { data } = await supabase
      .from('user_achievements')
      .select('progress')
      .eq('user_id', userId)
      .eq('achievement_id', achievementId)
      .maybeSingle();

    return data?.progress || 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Update Progress
  // ─────────────────────────────────────────────────────────────────────────────

  async incrementProgress(
    userId: string,
    achievementId: string,
    amount: number = 1
  ): Promise<{ unlocked: boolean; achievement?: Achievement }> {
    const achievement = this.getById(achievementId);
    if (!achievement) return { unlocked: false };

    // Get or create progress record
    const { data: existing } = await supabase
      .from('user_achievements')
      .select('id, progress, unlocked_at')
      .eq('user_id', userId)
      .eq('achievement_id', achievementId)
      .maybeSingle();

    // Already unlocked
    if (existing?.unlocked_at) {
      return { unlocked: false };
    }

    const currentProgress = existing?.progress || 0;
    const newProgress = Math.min(currentProgress + amount, achievement.requirement);
    const justUnlocked = newProgress >= achievement.requirement;

    if (existing) {
      // Update existing
      const { error: progErr } = await supabase
        .from('user_achievements')
        .update({
          progress: newProgress,
          unlocked_at: justUnlocked ? new Date().toISOString() : null,
        })
        .eq('id', existing.id);
      if (progErr) {
        console.error('[AchievementService] Progress update failed:', progErr);
        return { unlocked: false };
      }
    } else {
      // Create new
      const { error: insErr } = await supabase.from('user_achievements').insert({
        user_id: userId,
        achievement_id: achievementId,
        progress: newProgress,
        unlocked_at: justUnlocked ? new Date().toISOString() : null,
      });
      if (insErr) {
        console.error('[AchievementService] Achievement insert failed:', insErr);
        return { unlocked: false };
      }
    }

    // Award rewards if just unlocked
    if (justUnlocked) {
      await this.awardRewards(userId, achievement);
    }

    return { unlocked: justUnlocked, achievement: justUnlocked ? achievement : undefined };
  }

  async setProgress(userId: string, achievementId: string, progress: number): Promise<void> {
    const achievement = this.getById(achievementId);
    if (!achievement) return;

    const clampedProgress = Math.min(progress, achievement.requirement);
    const unlocked = clampedProgress >= achievement.requirement;

    const { error: upsertErr } = await supabase.from('user_achievements').upsert(
      {
        user_id: userId,
        achievement_id: achievementId,
        progress: clampedProgress,
        unlocked_at: unlocked ? new Date().toISOString() : null,
      },
      { onConflict: 'user_id,achievement_id' }
    );
    if (upsertErr) {
      console.debug('[AchievementService] setProgress upsert:', upsertErr?.message);
      return;
    }

    if (unlocked) {
      await this.awardRewards(userId, achievement);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Rewards
  // ─────────────────────────────────────────────────────────────────────────────

  private async awardRewards(userId: string, achievement: Achievement): Promise<void> {
    // Award chips
    if (achievement.chipReward && achievement.chipReward > 0) {
      const { error: rewardErr } = await retryAsync(
        () =>
          supabase.rpc('add_to_promo_wallet', {
            p_user_id: userId,
            p_amount: achievement.chipReward,
            p_description: `Achievement: ${achievement.name}`,
          }),
        3
      );
      if (rewardErr)
        console.error(
          `[AchievementService] Reward failed for ${userId.slice(0, 8)}: ${rewardErr.message}`
        );
    }

    // Create notification
    const { error: notifErr } = await supabase.from('notifications').insert({
      user_id: userId,
      type: 'achievement',
      title: ` Achievement Unlocked!`,
      message: `You earned "${achievement.name}"!`,
      data: { achievement_id: achievement.id },
    });
    if (notifErr) console.debug('[AchievementService] Notification insert failed:', notifErr);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Bulk Check (for game events)
  // ─────────────────────────────────────────────────────────────────────────────

  async checkHandsPlayed(userId: string, handsPlayed: number): Promise<Achievement[]> {
    const unlocked: Achievement[] = [];
    const handAchievements = ['hands_100', 'hands_1000', 'hands_10000', 'hands_100000'];

    for (const id of handAchievements) {
      const result = await this.incrementProgress(userId, id, 0);
      await this.setProgress(userId, id, handsPlayed);
      if (result.unlocked && result.achievement) {
        unlocked.push(result.achievement);
      }
    }
    return unlocked;
  }

  async checkWins(userId: string, totalWins: number): Promise<Achievement[]> {
    const unlocked: Achievement[] = [];
    const winAchievements = ['wins_10', 'wins_100', 'wins_1000'];

    for (const id of winAchievements) {
      const achievement = this.getById(id);
      if (achievement && totalWins >= achievement.requirement) {
        unlocked.push(achievement);
      }
      await this.setProgress(userId, id, totalWins);
    }
    return unlocked;
  }

  async checkSpecialHand(userId: string, handRank: string): Promise<Achievement | null> {
    // SECURITY: Validate handRank against known values to prevent garbage input
    const HAND_RANK_MAP: Record<string, string> = {
      royal_flush: 'royal_flush',
      straight_flush: 'straight_flush',
      four_of_a_kind: 'quads',
    };

    const achievementId = HAND_RANK_MAP[handRank] || null;
    if (achievementId) {
      const result = await this.incrementProgress(userId, achievementId, 1);
      return result.achievement || null;
    }
    return null;
  }
}

export const achievementService = new AchievementServiceClass();
