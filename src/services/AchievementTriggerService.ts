/**
 * ════════════════════════════════════════════════════════════════════════════════════
 *  ACHIEVEMENT TRIGGER SERVICE — Auto-Award Engine
 * ════════════════════════════════════════════════════════════════════════════════════
 *
 * Connects poker engine events to achievement progress.
 * Listens for hand completions, showdowns, wins, and special conditions
 * to automatically increment achievement progress.
 */

import { supabase } from '../lib/supabase';
import { achievementService, type Achievement } from './AchievementService';
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
// ════════════════════════════════════════════════════════════════════════════════════
// SERVICE
// ════════════════════════════════════════════════════════════════════════════════════
class AchievementTriggerServiceClass {
  /**
   * Process a completed hand and check for achievements
   * Called after HAND_COMPLETE (HandPersistenceService was deleted 2026-08-29; the engine owns hand persistence)
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

    // 5. Announce unlocked achievements.
    //
    // 2026-08-20: this only sent a PUSH notification. The whole in-app
    // celebration layer — AchievementNotification, MilestoneToast (mounted
    // app-wide in App.tsx) and FriendActivityFeed — listens on the bus for
    // ACHIEVEMENT_UNLOCKED / MILESTONE_UNLOCKED, and NOTHING in the repo ever
    // emitted either one. Achievements unlocked invisibly mid-session; the only
    // way a player found out was a push notification on their phone or by going
    // to /achievements later. Every one of those components was built, mounted
    // and inert.
    for (const ach of result.triggeredAchievements) {
      masterBus.emit('ACHIEVEMENT_UNLOCKED', {
        userId,
        achievementId: ach.id,
        name: ach.name,
        icon: ach.icon,
        rarity: ach.rarity,
        description: ach.description,
      });
      // MilestoneToast is the app-wide surface; it reads title/description/icon.
      masterBus.emit('MILESTONE_UNLOCKED', {
        milestoneId: ach.id,
        userId,
        milestoneName: ach.name,
        description: ach.description,
        icon: ach.icon,
        ...(ach.chipReward ? { reward: { chips: ach.chipReward } } : {}),
      });
      /* THE PUSH IS RAISED SERVER-SIDE NOW (2026-08-30, issue #1498).
       *
       * This called pushNotificationService.notifyAchievement, which has
       * delivered nothing since 2026-08-19, when OneSignal was removed from
       * the platform. Issue #1498 lists EIGHT such flows; this is a NINTH it
       * missed, because the call was split across lines and every
       * `pushNotificationService\.(...)` grep used to build that list walked
       * straight past it.
       *
       * It cannot simply be repointed at a working transport from here. The
       * browser has no write access to `notifications` or `push_outbox` (RLS,
       * service_role only), and granting it one would be the
       * arbitrary-recipient spam vector World Hub closed on 2026-07-25.
       *
       * `trg_notify_achievement_unlocked` now fires on the NULL to non-NULL
       * transition of `training_user_achievements.unlocked_at` — the trusted
       * context that already performs the action. It covers every writer of
       * that table rather than this one call site, so the next path that
       * unlocks something cannot forget it, and push-dispatch applies the
       * consent gate to what it enqueues. Nothing is needed here.
       */
    }

    // Daily Missions progress is recorded by the authoritative game server
    // after hand-history persistence; the browser never writes economy state.

    // 6. Bump any active 'hand_grinder' friend challenges (most hands wins).
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
  /**
   * ─────────────────────────────────────────────────────────────────────────
   * LOGIN STREAKS — once a DAY, not once a PAGE LOAD
   * ─────────────────────────────────────────────────────────────────────────
   * This used to loop three streak ids and call `incrementProgress` on each,
   * serially, EVERY time Supabase raised an auth event. Supabase raises one
   * on INITIAL_SESSION, on SIGNED_IN and on TOKEN_REFRESHED, so a player
   * reloading the page advanced "Log in 7 days in a row" seven times in an
   * afternoon and collected its reward. `streak_30` pays 100 chips and
   * `streak_100` pays 500, through `add_to_promo_wallet`. Production showed
   * the tell plainly: 3 of 5 `streak_7` unlocks and 1 of 2 `streak_30`
   * unlocks carried `unlocked_at` on the SAME DAY the row was created, which
   * a consecutive-day achievement cannot legitimately do.
   *
   * The streak is now a real streak, computed once per UTC day from columns
   * that already existed and that nothing had ever maintained:
   *
   *   profiles.last_login_date  the day we last counted   (all 1,023 stale)
   *   profiles.login_streak     the run length            (0 on all 1,023)
   *
   * Same day  -> nothing happens at all, and that is the whole fix: one
   *              SELECT and no writes, however many times the page reloads.
   * Yesterday -> the run continues, streak + 1.
   * Older     -> the run is broken, back to 1.
   *
   * The three achievements are then SET to the real streak rather than
   * incremented, so they say what their description says. They are written in
   * parallel — three independent rows, no ordering between them — where the
   * old loop awaited each in turn.
   */
  async onLogin(userId: string): Promise<TriggerResult> {
    const result: TriggerResult = { triggeredAchievements: [], chipsAwarded: 0 };

    const today = new Date().toISOString().slice(0, 10); // UTC calendar day

    const { data: profile, error: readErr } = await supabase
      .from('profiles')
      .select('login_streak, last_login_date')
      .eq('id', userId)
      .maybeSingle();

    if (readErr) {
      reportError(readErr, 'AchievementTriggerService.onLogin.read');
      return result;
    }

    // Already counted today. Nothing to write, nothing to award.
    if (profile?.last_login_date === today) return result;

    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const continuing = profile?.last_login_date === yesterday;
    const streak = continuing ? Number(profile?.login_streak || 0) + 1 : 1;

    // Claim the day FIRST. If the achievement writes below fail, the worst
    // outcome is a streak that did not advance — not a day counted twice.
    const { error: writeErr } = await supabase
      .from('profiles')
      .update({ login_streak: streak, last_login_date: today })
      .eq('id', userId);

    if (writeErr) {
      reportError(writeErr, 'AchievementTriggerService.onLogin.claimDay');
      return result;
    }

    const streakIds = ['streak_7', 'streak_30', 'streak_100'];
    const outcomes = await Promise.all(
      streakIds.map(async (id) => {
        try {
          return await achievementService.incrementProgressTo(userId, id, streak);
        } catch (e) {
          reportError(e, 'AchievementTriggerService.onLogin');
          return { unlocked: false } as { unlocked: boolean; achievement?: Achievement };
        }
      })
    );

    for (const outcome of outcomes) {
      if (outcome.unlocked && outcome.achievement) {
        result.triggeredAchievements.push(outcome.achievement);
        result.chipsAwarded += outcome.achievement.chipReward || 0;
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
    const { data, error } = await supabase
      .from('player_stats')
      .select('hands_played, tournaments_played, tournament_wins:tournaments_won')
      .eq('user_id', userId)
      .maybeSingle();

    /**
     * A FAILED READ IS NOT A PLAYER WITH NO HISTORY (2026-08-29).
     *
     * Only `data` was destructured, and every field below coalesces to 0. So a
     * refused or failed read returned the profile of somebody who has never
     * played a hand — which is the input the achievement checks then reason
     * from. "First hand" and "first tournament" milestones are exactly the ones
     * that go off on that reading, and some of them pay chips.
     *
     * The reads stay non-fatal — a stats hiccup must not break a hand — but the
     * failure is now visible instead of being laundered into a zero.
     */
    if (error) reportError(error, 'AchievementTriggerService.getUserStats');

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
