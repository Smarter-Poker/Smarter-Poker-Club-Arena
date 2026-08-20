/**
 * ════════════════════════════════════════════════════════════════════════════════════
 *  ACHIEVEMENT TRIGGER SERVICE — Auto-Award Engine
 * ════════════════════════════════════════════════════════════════════════════════════
 *
 * Connects poker engine events to achievement progress.
 * Listens for hand completions, showdowns, wins, and special conditions
 * to automatically increment achievement progress.
 */

import { supabase, getAuthUser } from '../lib/supabase';
import { achievementService, ACHIEVEMENTS, type Achievement } from './AchievementService';
import { pushNotificationService } from './PushNotificationService';
import { dailyChallengeService, BIG_POT_MIN, isStrongHand } from './DailyChallengeService';
import { masterBus } from '../core/MasterBus';
import { reportError } from '../utils/errorReporter';

// ════════════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════════════
interface TriggerResult {
  triggeredAchievements: Achievement[];
  chipsAwarded: number;
}

// ════════════════════════════════════════════════════════════════════════════════════
// CHALLENGE COMPLETION NOTICE
// ════════════════════════════════════════════════════════════════════════════════════

/**
 * Announce finished challenges wherever the player happens to be.
 *
 * SHOW_TOAST is routed to the live ToastProvider by BusToastBridge, which is
 * mounted once at the app root -- so this works from a table, the lobby, or a
 * tournament screen without any of them knowing challenges exist.
 *
 * Deliberately says what was WON and that it is waiting to be claimed. "Daily
 * challenge complete" alone gives the player nothing to act on, and an unclaimed
 * reward they never hear about is the same as no reward at all.
 */
function notifyChallengesCompleted(
  completed: Array<{ name: string; chipReward: number; diamondReward: number }>
): void {
  if (!completed || completed.length === 0) return;
  try {
    if (completed.length === 1) {
      const c = completed[0];
      const parts: string[] = [];
      if (c.diamondReward > 0) parts.push(`${c.diamondReward.toLocaleString()} diamonds`);
      if (c.chipReward > 0) parts.push(`${c.chipReward.toLocaleString()} chips`);
      masterBus.emit('SHOW_TOAST', {
        message: parts.length
          ? `Challenge complete: ${c.name} - ${parts.join(' and ')} ready to claim`
          : `Challenge complete: ${c.name}`,
        severity: 'info',
        source: 'daily_challenge',
        durationMs: 6000,
      });
      return;
    }
    // Several at once (common on the hand that finishes a daily and its weekly
    // parent). One line beats a stack of toasts covering the table.
    const diamonds = completed.reduce((s, c) => s + (c.diamondReward || 0), 0);
    const chips = completed.reduce((s, c) => s + (c.chipReward || 0), 0);
    const parts: string[] = [];
    if (diamonds > 0) parts.push(`${diamonds.toLocaleString()} diamonds`);
    if (chips > 0) parts.push(`${chips.toLocaleString()} chips`);
    masterBus.emit('SHOW_TOAST', {
      message: parts.length
        ? `${completed.length} challenges complete - ${parts.join(' and ')} ready to claim`
        : `${completed.length} challenges complete`,
      severity: 'info',
      source: 'daily_challenge',
      durationMs: 6000,
    });
  } catch {
    // A missed toast must never break a hand from settling.
  }
}

// ════════════════════════════════════════════════════════════════════════════════════
// SERVICE
// ════════════════════════════════════════════════════════════════════════════════════
class AchievementTriggerServiceClass {
  /**
   * Process a completed hand and check for achievements
   * Called by HandPersistenceService or HandController after HAND_COMPLETE
   */
  async onHandComplete(
    userId: string,
    handData: {
      won: boolean;
      potSize: number;
      handRank?: string; // e.g., 'Royal Flush', 'Full House'
      showdown: boolean;
    }
  ): Promise<TriggerResult> {
    const result: TriggerResult = {
      triggeredAchievements: [],
      chipsAwarded: 0,
    };

    // 1. Increment hands played
    const handsResult = await achievementService.incrementProgress(userId, 'hands_100');
    if (handsResult.unlocked && handsResult.achievement) {
      result.triggeredAchievements.push(handsResult.achievement);
    }

    // Also check higher tier hand achievements
    const userProgress = await this.getUserStats(userId);
    const handsPlayedAchievements = await achievementService.checkHandsPlayed(
      userId,
      userProgress.handsPlayed
    );
    for (const ach of handsPlayedAchievements) {
      result.triggeredAchievements.push(ach);
      result.chipsAwarded += ach.chipReward || 0;
    }

    // 2. If won, check win achievements
    if (handData.won) {
      const winsResult = await achievementService.checkWins(userId, userProgress.totalWins + 1);
      for (const ach of winsResult) {
        result.triggeredAchievements.push(ach);
        result.chipsAwarded += ach.chipReward || 0;
      }
    }

    // 3. Check for special hands
    if (handData.handRank) {
      const specialAch = await achievementService.checkSpecialHand(userId, handData.handRank);
      if (specialAch) {
        result.triggeredAchievements.push(specialAch);
        result.chipsAwarded += specialAch.chipReward || 0;
      }
    }

    // 4. Update user stats
    await this.updateUserStats(userId, {
      handsPlayed: 1,
      wins: handData.won ? 1 : 0,
    });

    // 5. Send push notification for unlocked achievements
    for (const ach of result.triggeredAchievements) {
      pushNotificationService
        .notifyAchievement(userId, ach.name)
        .catch((err) => reportError(err, 'AchievementTriggerService.Push_notification_failed'));
    }

    // 6. Update Daily Challenge progress (fire-and-forget, non-blocking)
    try {
      // ONE round trip for all three counters. This used to be up to three
      // parallel updateProgress() calls, each doing its own select plus an RPC
      // per matching row -- roughly 3 selects and 8 RPCs per player per hand at
      // table speed. bump_challenge_progress does it in a single statement and
      // returns only the challenges that just crossed into completion.
      const { advanced, completed } = await dailyChallengeService.bumpProgress(userId, {
        hands_played: 1,
        ...(handData.won ? { hands_won: 1 } : {}),
        ...(handData.showdown ? { showdowns: 1 } : {}),
        // Skill/excitement counters, from data this callback already receives
        // and used to discard. A big pot only counts if it was actually WON --
        // being in a large pot you lost is not an achievement.
        ...(handData.won && (handData.potSize || 0) >= BIG_POT_MIN ? { big_pots: 1 } : {}),
        ...(isStrongHand(handData.handRank) ? { strong_hands: 1 } : {}),
      });

      // Fire on ANY movement, not just completion. This previously only emitted
      // when a challenge finished, so a challenges tab left open beside the
      // table sat frozen for a whole session -- which reads as "this feature is
      // broken", not as "you are three hands away".
      if (advanced.length > 0) {
        masterBus.emit('CHALLENGE_PROGRESS_UPDATED', {
          userId,
          source: 'hand_complete',
          // Distinct per hand so the 500ms bus dedup cannot swallow a real tick.
          at: Date.now(),
        });
      }

      // Tell the player, wherever they are. Finishing a challenge used to be
      // completely silent unless they happened to have /challenges open: the
      // reward landed in a list they had no reason to visit. A daily loop that
      // never announces its own payoff does not loop.
      notifyChallengesCompleted(completed);
    } catch (dcErr) {
      console.debug('[AchievementTrigger] Daily challenge progress update failed:', dcErr);
    }

    // 7. Bump any active 'hand_grinder' friend challenges (most hands wins).
    supabase
      .rpc('fn_bump_friend_challenge_progress', { p_challenge_type: 'hand_grinder', p_amount: 1 })
      .then(({ error }) => {
        if (error)
          console.debug('[AchievementTrigger] friend-challenge bump failed:', error.message);
      });

    return result;
  }

  /**
   * Process tournament completion
   */
  async onTournamentComplete(
    userId: string,
    tournamentData: {
      position: number;
      entries: number;
      won: boolean;
      prizeAmount: number;
    }
  ): Promise<TriggerResult> {
    const result: TriggerResult = {
      triggeredAchievements: [],
      chipsAwarded: 0,
    };

    // Increment tournament play count
    // FIX: Achievement ID was 'tourney_played_10' which doesn't exist.
    // Correct ID from ACHIEVEMENTS array is 'tourney_played_50'.
    const playedResult = await achievementService.incrementProgress(userId, 'tourney_played_50');
    if (playedResult.unlocked && playedResult.achievement) {
      result.triggeredAchievements.push(playedResult.achievement);
    }

    // Check wins
    if (tournamentData.won) {
      // FIX: Achievement ID was 'tourney_wins_5' which doesn't exist.
      // Correct ID from ACHIEVEMENTS array is 'tourney_win_1'.
      const winResult = await achievementService.incrementProgress(userId, 'tourney_win_1');
      if (winResult.unlocked && winResult.achievement) {
        result.triggeredAchievements.push(winResult.achievement);
      }
    }

    // Update Daily Challenge progress for tournaments
    try {
      const dcResult = await dailyChallengeService.updateProgress(userId, 'tournaments_played', 1);
      if (dcResult.completed.length > 0) {
        masterBus.emit('CHALLENGE_PROGRESS_UPDATED', {
          userId,
          source: 'tournament_complete',
          at: Date.now(),
        });
        notifyChallengesCompleted(dcResult.completed.map((c) => c.challenge));
      }
    } catch (dcErr) {
      console.debug('[AchievementTrigger] Daily challenge tournament progress failed:', dcErr);
    }

    return result;
  }

  /**
   * Process friend added
   */
  async onFriendAdded(userId: string): Promise<TriggerResult> {
    const result: TriggerResult = {
      triggeredAchievements: [],
      chipsAwarded: 0,
    };

    const friendResult = await achievementService.incrementProgress(userId, 'friends_5');
    if (friendResult.unlocked && friendResult.achievement) {
      result.triggeredAchievements.push(friendResult.achievement);
    }

    // Check higher tiers
    const higherResult = await achievementService.incrementProgress(userId, 'friends_25');
    if (higherResult.unlocked && higherResult.achievement) {
      result.triggeredAchievements.push(higherResult.achievement);
    }

    return result;
  }

  /**
   * Process login (for login streak achievements)
   */
  async onLogin(userId: string): Promise<TriggerResult> {
    const result: TriggerResult = {
      triggeredAchievements: [],
      chipsAwarded: 0,
    };

    // Login streak achievements
    const streakIds = ['streak_7', 'streak_30', 'streak_100'];
    for (const streakId of streakIds) {
      try {
        const streakResult = await achievementService.incrementProgress(userId, streakId);
        if (streakResult.unlocked && streakResult.achievement) {
          result.triggeredAchievements.push(streakResult.achievement);
          result.chipsAwarded += streakResult.achievement.chipReward || 0;
        }
      } catch (e) {
        reportError(e, 'AchievementTriggerService.onLogin');
        // Achievement not found or already unlocked — skip
      }
    }

    return result;
  }

  /**
   * Get user's current stats for achievement checking
   */
  private async getUserStats(userId: string): Promise<{
    handsPlayed: number;
    totalWins: number;
    tournamentsPlayed: number;
    tournamentWins: number;
    friendsCount: number;
  }> {
    // NOTE: player_stats has no total_wins column (win count is not tracked) and
    // friends_count lives on `profiles`, not here. tournament_wins is aliased from
    // the real column tournaments_won. Absent stats default to 0.
    const { data } = await supabase
      .from('player_stats')
      .select('hands_played, tournaments_played, tournament_wins:tournaments_won')
      .eq('user_id', userId)
      .maybeSingle();

    return {
      handsPlayed: data?.hands_played || 0,
      totalWins: 0,
      tournamentsPlayed: data?.tournaments_played || 0,
      tournamentWins: data?.tournament_wins || 0,
      friendsCount: 0,
    };
  }

  /**
   * Update user stats after game events
   */
  private async updateUserStats(
    userId: string,
    increments: {
      handsPlayed?: number;
      wins?: number;
      tournaments?: number;
      tournamentWins?: number;
    }
  ): Promise<void> {
    // FIX: Previous check-then-act pattern had a race condition — two concurrent
    // hands could both read the same stats, compute incremented values locally,
    // and write back, losing one increment. Now uses upsert with DB-side defaults
    // and a server-side increment approach: upsert first, then UPDATE with addition.
    try {
      // NOTE: player_stats has no total_wins column (win count is not tracked), and
      // the real tournament-wins column is `tournaments_won`. Writing phantom columns
      // would 42703-error the whole request, so we only touch real columns here.
      // Step 1: Ensure row exists (idempotent upsert with zero defaults)
      const { error: upsertErr } = await supabase.from('player_stats').upsert(
        {
          user_id: userId,
          hands_played: increments.handsPlayed || 0,
          tournaments_played: increments.tournaments || 0,
          tournaments_won: increments.tournamentWins || 0,
        },
        { onConflict: 'user_id', ignoreDuplicates: true }
      );
      if (upsertErr) {
        console.debug('[AchievementTrigger] Stats upsert failed:', upsertErr);
        return;
      }

      // Step 2: Atomic increment — uses raw SQL-like update to avoid read-modify-write race
      // PostgREST doesn't support SET col = col + N natively, so we read-then-update
      // but scope the update to this user's row (single-row lock in Postgres)
      const { data: existing } = await supabase
        .from('player_stats')
        .select('hands_played, tournaments_played, tournaments_won')
        .eq('user_id', userId)
        .maybeSingle();

      if (existing) {
        const { error: updateErr } = await supabase
          .from('player_stats')
          .update({
            hands_played: (existing.hands_played || 0) + (increments.handsPlayed || 0),
            tournaments_played: (existing.tournaments_played || 0) + (increments.tournaments || 0),
            tournaments_won: (existing.tournaments_won || 0) + (increments.tournamentWins || 0),
          })
          .eq('user_id', userId);

        if (updateErr) reportError(updateErr, 'AchievementTriggerService.Stats_update_failed');
      }
    } catch (err) {
      console.debug('[AchievementTrigger] Stats update unexpected error:', err);
    }
  }
}

export const achievementTriggerService = new AchievementTriggerServiceClass();
export default achievementTriggerService;

// ════════════════════════════════════════════════════════════════════════════════════
// AUTO-WIRE: tournaments_played challenge trigger via bus event
//
// onTournamentComplete() — the only thing that increments 'tournaments_played'
// — had ZERO production call sites (only tests referenced it). Every tournament
// challenge was therefore unwinnable: tourney_1, tourney_2, tourney_3,
// weekly_tourneys_10 and monthly_tourneys_50 could be assigned, shown with a
// progress bar, and never move. With 5 daily challenges drawn from a pool that
// guarantees one per activity type, a tournament challenge appears EVERY day.
//
// TOURNAMENT_REGISTERED is the correct signal: the challenge copy is "Play N
// tournaments today", which is entering, not finishing. It also fires once per
// entrant with the userId in the payload, so it works for every player rather
// than only the one whose client happens to run the completion path.
// ════════════════════════════════════════════════════════════════════════════════════
masterBus.subscribe('TOURNAMENT_REGISTERED', async (payload: any) => {
  try {
    let userId: string | undefined = payload?.userId;
    if (!userId) {
      const {
        data: { user },
      } = await getAuthUser();
      userId = user?.id;
    }
    if (!userId) return;
    const res = await dailyChallengeService.updateProgress(userId, 'tournaments_played', 1);
    if (res.completed.length > 0) {
      masterBus.emit('CHALLENGE_PROGRESS_UPDATED', {
        userId,
        source: 'tournament_registered',
        at: Date.now(),
      });
      notifyChallengesCompleted(res.completed.map((c) => c.challenge));
    }
  } catch (err) {
    console.debug('[AchievementTrigger] Tournament challenge update failed:', err);
  }
});
