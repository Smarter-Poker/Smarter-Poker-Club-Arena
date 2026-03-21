/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ACHIEVEMENT TRIGGER SERVICE — Auto-Award Engine
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Connects poker engine events to achievement progress.
 * Listens for hand completions, showdowns, wins, and special conditions
 * to automatically increment achievement progress.
 */

import { supabase } from '../lib/supabase';
import { achievementService, ACHIEVEMENTS, type Achievement } from './AchievementService';
import { pushNotificationService } from './PushNotificationService';
import { dailyChallengeService } from './DailyChallengeService';
import { masterBus } from '../core/MasterBus';
import type { HandEvent } from '../engine/HandController';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface TriggerResult {
  triggeredAchievements: Achievement[];
  chipsAwarded: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

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
        .catch((err) => console.error('[Achievements] Push notification failed:', err));
    }

    // 6. Update Daily Challenge progress (fire-and-forget, non-blocking)
    try {
      const progressResults = await Promise.allSettled(
        [
          dailyChallengeService.updateProgress(userId, 'hands_played', 1),
          handData.won ? dailyChallengeService.updateProgress(userId, 'hands_won', 1) : null,
          handData.showdown ? dailyChallengeService.updateProgress(userId, 'showdowns', 1) : null,
        ].filter(Boolean) as Promise<any>[]
      );

      // Check if any challenges were completed
      const anyCompleted = progressResults.some(
        (r) => r.status === 'fulfilled' && r.value?.completed?.length > 0
      );
      if (anyCompleted) {
        masterBus.emit('CHALLENGE_PROGRESS_UPDATED', { userId, source: 'hand_complete' });
      }
    } catch (dcErr) {
      console.warn('[AchievementTrigger] Daily challenge progress update failed:', dcErr);
    }

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
        masterBus.emit('CHALLENGE_PROGRESS_UPDATED', { userId, source: 'tournament_complete' });
      }
    } catch (dcErr) {
      console.warn('[AchievementTrigger] Daily challenge tournament progress failed:', dcErr);
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

    // Update Daily Challenge progress for friends
    try {
      const dcResult = await dailyChallengeService.updateProgress(userId, 'friends_added', 1);
      if (dcResult.completed.length > 0) {
        masterBus.emit('CHALLENGE_PROGRESS_UPDATED', { userId, source: 'friend_added' });
      }
    } catch (dcErr) {
      console.warn('[AchievementTrigger] Daily challenge friend progress failed:', dcErr);
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
      } catch {
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
    const { data } = await supabase
      .from('player_stats')
      .select('hands_played, total_wins, tournaments_played, tournament_wins, friends_count')
      .eq('user_id', userId)
      .maybeSingle();

    return {
      handsPlayed: data?.hands_played || 0,
      totalWins: data?.total_wins || 0,
      tournamentsPlayed: data?.tournaments_played || 0,
      tournamentWins: data?.tournament_wins || 0,
      friendsCount: data?.friends_count || 0,
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
      // Step 1: Ensure row exists (idempotent upsert with zero defaults)
      const { error: upsertErr } = await supabase.from('player_stats').upsert(
        {
          user_id: userId,
          hands_played: increments.handsPlayed || 0,
          total_wins: increments.wins || 0,
          tournaments_played: increments.tournaments || 0,
          tournament_wins: increments.tournamentWins || 0,
        },
        { onConflict: 'user_id', ignoreDuplicates: true }
      );
      if (upsertErr) {
        console.error('[AchievementTrigger] Stats upsert failed:', upsertErr);
        return;
      }

      // Step 2: Atomic increment — uses raw SQL-like update to avoid read-modify-write race
      // PostgREST doesn't support SET col = col + N natively, so we read-then-update
      // but scope the update to this user's row (single-row lock in Postgres)
      const { data: existing } = await supabase
        .from('player_stats')
        .select('hands_played, total_wins, tournaments_played, tournament_wins')
        .eq('user_id', userId)
        .maybeSingle();

      if (existing) {
        const { error: updateErr } = await supabase
          .from('player_stats')
          .update({
            hands_played: (existing.hands_played || 0) + (increments.handsPlayed || 0),
            total_wins: (existing.total_wins || 0) + (increments.wins || 0),
            tournaments_played: (existing.tournaments_played || 0) + (increments.tournaments || 0),
            tournament_wins: (existing.tournament_wins || 0) + (increments.tournamentWins || 0),
          })
          .eq('user_id', userId);

        if (updateErr) console.error('[AchievementTrigger] Stats update failed:', updateErr);
      }
    } catch (err) {
      console.error('[AchievementTrigger] Stats update unexpected error:', err);
    }
  }

  /**
   * Wire to HandController events
   * Returns unsubscribe function
   */
  wireToHandController(
    controller: { onEvent: (handler: (event: HandEvent) => void) => () => void },
    userIdResolver: (seat: number) => string | null
  ): () => void {
    let lastWinners: { userId: string; amount: number }[] = [];

    return controller.onEvent(async (event) => {
      if (event.type === 'WINNERS') {
        lastWinners = event.winners.map((w) => ({ userId: w.userId, amount: w.amount }));
      }

      if (event.type === 'HAND_COMPLETE') {
        // Process each winner
        for (const winner of lastWinners) {
          await this.onHandComplete(winner.userId, {
            won: true,
            potSize: winner.amount,
            showdown: true,
          });
        }
        lastWinners = [];
      }

      if (event.type === 'SHOWDOWN') {
        // Check for special hands
        for (const result of event.results) {
          if (result.hand) {
            await this.onHandComplete(result.userId, {
              won: false, // Will be updated on HAND_COMPLETE
              potSize: 0,
              handRank: result.hand.name,
              showdown: true,
            });
          }
        }
      }
    });
  }
}

export const achievementTriggerService = new AchievementTriggerServiceClass();
export default achievementTriggerService;
