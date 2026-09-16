/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ACHIEVEMENT SERVICE — Gamification & Badge System
 * Manages player achievements, badges, and unlock tracking
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';

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
    description: 'Play 100 Hands',
    icon: '',
    category: 'hands',
    rarity: 'common',
    requirement: 100,
    chipReward: 0,
  },
  {
    id: 'hands_1000',
    name: 'Regular',
    description: 'Play 1,000 Hands',
    icon: '',
    category: 'hands',
    rarity: 'rare',
    requirement: 1000,
    chipReward: 0,
  },
  {
    id: 'hands_10000',
    name: 'Grinder',
    description: 'Play 10,000 Hands',
    icon: '',
    category: 'hands',
    rarity: 'epic',
    requirement: 10000,
    chipReward: 0,
  },
  {
    id: 'hands_100000',
    name: 'Professional',
    description: 'Play 100,000 Hands',
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
    description: 'Win 10 Hands',
    icon: '☆',
    category: 'wins',
    rarity: 'common',
    requirement: 10,
    chipReward: 0,
  },
  {
    id: 'wins_100',
    name: 'Winner',
    description: 'Win 100 Hands',
    icon: '',
    category: 'wins',
    rarity: 'rare',
    requirement: 100,
    chipReward: 0,
  },
  {
    id: 'wins_1000',
    name: 'Dominator',
    description: 'Win 1,000 Hands',
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
    description: 'Add 5 Friends',
    icon: '◆',
    category: 'social',
    rarity: 'common',
    requirement: 5,
    chipReward: 0,
  },
  {
    id: 'friends_25',
    name: 'Popular',
    description: 'Add 25 Friends',
    icon: '',
    category: 'social',
    rarity: 'rare',
    requirement: 25,
    chipReward: 0,
  },
  {
    id: 'clubs_3',
    name: 'Club Hopper',
    description: 'Join 3 Clubs',
    icon: '',
    category: 'social',
    rarity: 'common',
    requirement: 3,
    chipReward: 0,
  },

  // Financial
  {
    id: 'profit_1000',
    name: 'In The Green',
    description: 'Profit 1,000 Chips',
    icon: '',
    category: 'financial',
    rarity: 'rare',
    requirement: 1000,
    chipReward: 0,
  },
  {
    id: 'profit_10000',
    name: 'High Roller',
    description: 'Profit 10,000 Chips',
    icon: '',
    category: 'financial',
    rarity: 'epic',
    requirement: 10000,
    chipReward: 0,
  },
  {
    id: 'biggest_pot_500',
    name: 'Big Pot',
    description: 'Win A 500+ Chip Pot',
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
    description: 'Win A Tournament',
    icon: '',
    category: 'tournament',
    rarity: 'epic',
    requirement: 1,
    chipReward: 0,
  },
  {
    id: 'tourney_top3_10',
    name: 'Consistent',
    description: 'Finish Top 3 In 10 Tournaments',
    icon: '',
    category: 'tournament',
    rarity: 'rare',
    requirement: 10,
    chipReward: 0,
  },
  {
    id: 'tourney_played_50',
    name: 'Tournament Regular',
    description: 'Play 50 Tournaments',
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
    description: 'Hit A Royal Flush',
    icon: '',
    category: 'special',
    rarity: 'legendary',
    requirement: 1,
    // 0 since 2026-09-09. See the note above `awardRewards`: the door this paid
    // through is retired and there is no funded automatic source, so a non-zero
    // figure here only ever advertised a credit that could not land.
    chipReward: 0,
  },
  {
    id: 'straight_flush',
    name: 'Straight Flush',
    description: 'Hit A Straight Flush',
    icon: '',
    category: 'special',
    rarity: 'epic',
    requirement: 1,
    chipReward: 0,
  },
  {
    id: 'quads',
    name: 'Four Of A Kind',
    description: 'Hit Quads',
    icon: '4',
    category: 'special',
    rarity: 'rare',
    requirement: 1,
    chipReward: 0,
  },
  {
    id: 'bad_beat',
    name: 'Bad Beat Survivor',
    description: 'Lose With Quads Or Better',
    icon: '',
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
    description: 'Log In 7 Days In A Row',
    icon: '',
    category: 'special',
    rarity: 'common',
    requirement: 7,
    chipReward: 0,
  },
  {
    id: 'streak_30',
    name: 'Monthly Grinder',
    description: 'Log In 30 Days In A Row',
    icon: '▤',
    category: 'special',
    rarity: 'rare',
    requirement: 30,
    // 0 since 2026-09-09 - see `awardRewards`.
    chipReward: 0,
  },
  {
    id: 'streak_100',
    name: 'Centurion',
    description: 'Log In 100 Days In A Row',
    icon: '◆',
    category: 'special',
    rarity: 'legendary',
    requirement: 100,
    // 0 since 2026-09-09 - see `awardRewards`.
    chipReward: 0,
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// ACHIEVEMENT SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class AchievementServiceClass {
  /** FIX-216: Circuit breaker — disable DB writes after persistent failures (missing table) */
  private _dbWriteDisabled = false;
  private _dbWriteFailures = 0;
  /** Read-side breaker — silence RLS/permission read errors after first report */
  private _dbReadDisabled = false;

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
    // Silent breaker — avoids Sentry flood from polling when table/RLS blocks reads
    if (this._dbReadDisabled) return [];

    const { data, error } = await supabase
      .from('training_user_achievements')
      .select('id, achievement_id, user_id, progress, unlocked_at')
      .eq('user_id', userId)
      .limit(QUERY_LIMITS.MODERATE);

    if (error) {
      this._dbReadDisabled = true;
      reportError(error, 'AchievementService.getUserAchievements', {
        userId,
        note: 'Disabling subsequent reads - likely missing table or RLS',
      });
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
      .from('training_user_achievements')
      .select('progress')
      .eq('user_id', userId)
      .eq('achievement_id', achievementId)
      .maybeSingle();

    return data?.progress || 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Update Progress
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Add to an achievement's progress.
   *
   * REWRITTEN 2026-08-29. This used to SELECT the row, decide in JavaScript,
   * then UPDATE or INSERT. `.maybeSingle()` ERRORS when more than one row
   * matches, only `data` was destructured, so that error was discarded and
   * `existing` came back undefined — which reads as "no row yet", so it
   * INSERTed. There was no unique constraint to stop it. One duplicate begets
   * the next: production held 33,353 rows for 44 real (user, achievement)
   * pairs, the worst single pair 13,047 rows, still growing one row per page
   * load. Progress could never accumulate, so an achievement counted this way
   * could essentially never be earned.
   *
   * `fn_achievement_record_progress` does the whole thing in one statement:
   * progress only rises, the unlock is set once and never cleared, and it
   * returns true ONLY on the call that flipped it - so `awardRewards` fires
   * exactly once even with several tabs open.
   *
   * CORRECTED 2026-09-09: this sentence used to end "so `awardRewards`, which
   * moves real chips through `add_to_promo_wallet`, fires exactly once". It
   * moves no chips and has not since 2026-09-03, when
   * `20260903234327_the_phantom_promo_pool_is_retired_and_its_doors_are_shut`
   * made that function raise unconditionally. See `awardRewards`.
   */
  async incrementProgress(
    userId: string,
    achievementId: string,
    amount: number = 1
  ): Promise<{ unlocked: boolean; achievement?: Achievement }> {
    if (this._dbWriteDisabled) return { unlocked: false };

    const achievement = this.getById(achievementId);
    if (!achievement) return { unlocked: false };

    // The read is only to know what to add to. It is NOT the write, so a
    // stale answer here cannot corrupt anything: the RPC clamps with
    // GREATEST against whatever is really stored.
    const { data: existing, error: readErr } = await supabase
      .from('training_user_achievements')
      .select('progress, unlocked_at')
      .eq('user_id', userId)
      .eq('achievement_id', achievementId)
      .maybeSingle();

    // The error is HANDLED now rather than dropped. Dropping it is what
    // turned "I could not read this row" into "this row does not exist".
    if (readErr) {
      reportError(readErr, 'AchievementService.incrementProgress.read', {
        userId,
        achievementId,
      });
      return { unlocked: false };
    }

    if (existing?.unlocked_at) return { unlocked: false };

    const target = achievement.requirement;
    const next = Math.min(Number(existing?.progress || 0) + amount, target);

    return this._record(userId, achievement, next);
  }

  /**
   * The single write path for every achievement in the app.
   * Returns whether THIS call unlocked it, and pays the reward if so.
   */
  private async _record(
    userId: string,
    achievement: Achievement,
    progress: number
  ): Promise<{ unlocked: boolean; achievement?: Achievement }> {
    const { data: justUnlocked, error } = await supabase.rpc('fn_achievement_record_progress', {
      p_user_id: userId,
      p_achievement_id: achievement.id,
      p_progress: progress,
      p_target: achievement.requirement,
    });

    if (error) {
      this._dbWriteFailures++;
      if (this._dbWriteFailures >= 3) {
        this._dbWriteDisabled = true;
        console.debug(
          '[AchievementService] DB writes disabled - training_user_achievements unavailable'
        );
      }
      if (this._dbWriteFailures <= 3) {
        reportError(error, 'AchievementService.record', {
          userId,
          achievementId: achievement.id,
          failureCount: this._dbWriteFailures,
        });
      }
      return { unlocked: false };
    }

    if (justUnlocked === true) {
      await this.awardRewards(userId, achievement);
      return { unlocked: true, achievement };
    }
    return { unlocked: false };
  }

  /**
   * Raise an achievement to an absolute figure and report whether THIS call
   * unlocked it. `setProgress` is the same thing without the answer.
   *
   * Login streaks need the answer: the caller pays out and notifies on the
   * transition, and the transition has to be decided by the write itself,
   * not guessed at afterwards by re-reading a row another tab may have moved.
   */
  async incrementProgressTo(
    userId: string,
    achievementId: string,
    progress: number
  ): Promise<{ unlocked: boolean; achievement?: Achievement }> {
    if (this._dbWriteDisabled) return { unlocked: false };
    const achievement = this.getById(achievementId);
    if (!achievement) return { unlocked: false };
    return this._record(userId, achievement, Math.min(progress, achievement.requirement));
  }

  /**
   * Set an achievement to an absolute figure (a recount, not an increment).
   *
   * Routed through the same atomic RPC as `incrementProgress` since
   * 2026-08-29. The old body called `.upsert(..., { onConflict:
   * 'user_id,achievement_id' })` against a table that had NO unique
   * constraint on those columns, so ON CONFLICT had nothing to match and the
   * call failed every time it ran. It also wrote `unlocked_at: unlocked ?
   * now : null`, which meant a smaller recount REVOKED an achievement the
   * player already held. The RPC cannot do either: progress only rises and
   * an unlock is never cleared.
   */
  async setProgress(userId: string, achievementId: string, progress: number): Promise<void> {
    if (this._dbWriteDisabled) return;
    const achievement = this.getById(achievementId);
    if (!achievement) return;
    await this._record(userId, achievement, Math.min(progress, achievement.requirement));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Rewards
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * NO ACHIEVEMENT PAYS CHIPS (2026-09-09).
   *
   * This used to call `add_to_promo_wallet` for the three achievements that
   * carried a `chipReward` (royal_flush 500, streak_30 100, streak_100 500).
   * That function has raised unconditionally since 2026-09-03
   * (`20260903234327_the_phantom_promo_pool_is_retired_and_its_doors_are_shut`):
   * "A deposit bonus, referral bonus or achievement reward needs a funded
   * source before it can pay ... leaderboards are the only automatic promo
   * payout. (Dan, 2026-09-03.)"
   *
   * The raise was only `reportError`ed, and the notification below plus the
   * MILESTONE_UNLOCKED toast then told the player they had earned the chips.
   * Nothing repaired that afterwards and nothing could: `_record` calls this
   * only when `fn_achievement_record_progress` returns true, which happens
   * ONCE EVER per (user, achievement), so every one of those credits was lost
   * the moment it was announced.
   *
   * There is no funded automatic source to route it to, and Dan's ruling of
   * 2026-09-05 is broader than this file: "NOTHING EVER 'EARNS CHIPS' ONLY
   * EVER DIAMONDS. MAKE SURE THATS THE CASE GLOBALLY!"
   * (`tests/a-reward-is-paid-in-diamonds.law.test.ts`). So the three figures
   * are 0 and the credit is gone rather than replaced. A player is told what
   * they unlocked, which is true, and never told about money.
   *
   * The guard below is not a repair - nothing is repaired here. It exists so
   * that a future editor who sets a `chipReward` finds out from an error
   * instead of from a player who was promised chips nobody sent.
   */
  private async awardRewards(userId: string, achievement: Achievement): Promise<void> {
    if (achievement.chipReward && achievement.chipReward > 0) {
      reportError(
        new Error(
          `Achievement "${achievement.id}" carries chipReward=${achievement.chipReward} but no ` +
            'funded automatic door exists to pay it. Route it through a funded owner path or ' +
            'set it to 0; do not announce it.'
        ),
        'AchievementService.awardRewards.unfundedChipReward',
        { userId: userId.slice(0, 8), achievementName: achievement.name }
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
    if (notifErr) reportError(notifErr, 'AchievementService.Notification_insert_failed');
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
