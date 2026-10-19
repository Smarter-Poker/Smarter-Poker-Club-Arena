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
  /** Diamonds the SERVER credited for these unlocks (never a client estimate). */
  diamondsAwarded: number;
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
      /** The club that dealt the hand. `player_stats` is keyed per club. */
      clubId?: string;
    }
  ): Promise<TriggerResult> {
    const result: TriggerResult = {
      triggeredAchievements: [],
      diamondsAwarded: 0,
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
    }

    // 2. If won, check win achievements
    if (handData.won) {
      const winsResult = await achievementService.checkWins(userId, userProgress.totalWins + 1);
      for (const ach of winsResult) {
        result.triggeredAchievements.push(ach);
      }
    }

    // 3. Check for special hands
    if (handData.handRank) {
      const specialAch = await achievementService.checkSpecialHand(userId, handData.handRank);
      if (specialAch) {
        result.triggeredAchievements.push(specialAch);
      }
    }

    // 4. Update user stats, against the club whose table dealt the hand.
    await this.updateUserStats(
      userId,
      {
        handsPlayed: 1,
        wins: handData.won ? 1 : 0,
      },
      handData.clubId
    );

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
    //
    // Everything recorded from here is a badge the browser reports, and a
    // badge pays nothing (2026-10-19: only server-proved achievements carry a
    // reward - the Royal Flush is proved and paid from the engine's own hand
    // record, and announced by the server's notification).
    for (const ach of result.triggeredAchievements) {
      this.announce(userId, ach, 0);
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
      diamondsAwarded: 0,
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
      diamondsAwarded: 0,
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
   * Celebrate an unlock in-app. AchievementNotification, MilestoneToast
   * (mounted app-wide in App.tsx) and FriendActivityFeed listen on the bus for
   * ACHIEVEMENT_UNLOCKED / MILESTONE_UNLOCKED (2026-08-20: nothing emitted
   * them, so unlocks happened invisibly). `diamonds` is what the server
   * credited, never an estimate.
   *
   * THE PUSH IS RAISED SERVER-SIDE (2026-08-30, issue #1498):
   * `trg_notify_achievement_unlocked` fires on the NULL to non-NULL transition
   * of `training_user_achievements.unlocked_at` and now carries the diamonds
   * paid. The browser has no write access to `notifications` or `push_outbox`,
   * and push-dispatch applies the consent gate. Nothing is needed here.
   */
  private announce(userId: string, ach: Achievement, diamonds: number): void {
    masterBus.emit('ACHIEVEMENT_UNLOCKED', {
      userId,
      achievementId: ach.id,
      name: ach.name,
      icon: ach.icon,
      rarity: ach.rarity,
      description: ach.description,
      ...(diamonds > 0 ? { diamondReward: diamonds } : {}),
    });
    // MilestoneToast is the app-wide surface; it reads title/description/icon.
    masterBus.emit('MILESTONE_UNLOCKED', {
      milestoneId: ach.id,
      userId,
      milestoneName: ach.name,
      description: ach.description,
      icon: ach.icon,
      ...(diamonds > 0 ? { rewardDiamonds: diamonds } : {}),
    });
  }

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * LOGIN STREAKS — once a DAY, counted by the SERVER (2026-10-19)
   * ─────────────────────────────────────────────────────────────────────────
   * Supabase raises an auth event on INITIAL_SESSION, SIGNED_IN and
   * TOKEN_REFRESHED, so this runs many times a day. On 2026-08-29 it stopped
   * counting page loads (a reload farmed "Log in 7 days in a row"), but the
   * day was still decided here and written straight to
   * profiles.login_streak / last_login_date by the browser - so the streak
   * behind streak_30 (100 diamonds) and streak_100 (500) was a number the
   * player could type.
   *
   * fn_achievement_record_login now does the whole thing on the server clock
   * (UTC day): same day -> nothing; yesterday -> streak + 1; older -> 1. It
   * maintains the two columns itself (browsers no longer hold UPDATE on
   * them), records streak_7/30/100 at that streak, and pays the reward once
   * through award_diamonds_v2. This only announces what it reports.
   */
  async onLogin(userId: string): Promise<TriggerResult> {
    const result: TriggerResult = { triggeredAchievements: [], diamondsAwarded: 0 };

    let login: Awaited<ReturnType<typeof achievementService.recordLogin>>;
    try {
      login = await achievementService.recordLogin();
    } catch (e) {
      reportError(e, 'AchievementTriggerService.onLogin');
      return result;
    }

    for (const { achievement, diamondsAwarded } of login.unlocked) {
      result.triggeredAchievements.push(achievement);
      result.diamondsAwarded += diamondsAwarded;
      this.announce(userId, achievement, diamondsAwarded);
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
    /**
     * `player_stats` IS PER (user_id, club_id), NOT PER PLAYER (2026-09-05).
     *
     * This asked for `.eq('user_id', userId).maybeSingle()`. The table's unique
     * key is `(user_id, club_id)`, so ANY player who belongs to two or more
     * clubs returns two or more rows, and PostgREST answers `maybeSingle()`
     * with PGRST116 - an ERROR, not a row. `data` was then null and every
     * field below coalesced to 0.
     *
     * Measured on production 2026-09-05: 963 of 1,310 players hold more than
     * one `player_stats` row, so for 73% of the platform this function
     * reported ZERO HANDS, ZERO TOURNAMENTS, FOREVER. That is why only 12
     * achievements have ever unlocked platform-wide across 23 definitions,
     * and why `profiles.total_hands_played >= 100` matched nobody at all.
     * Achievements are platform-wide, so the honest answer is the SUM of the
     * player's club rows, not one of them.
     *
     * Same PGRST116 shape as the reciprocal-friendship read fixed on
     * PublicProfilePage: a bounded multi-row read asked for a single row.
     */
    const { data: rows, error } = await supabase
      .from('player_stats')
      .select('hands_played, tournaments_played, tournaments_won')
      .eq('user_id', userId);
    const data = (rows || []).reduce(
      (acc, row) => ({
        hands_played: acc.hands_played + (Number(row.hands_played) || 0),
        tournaments_played: acc.tournaments_played + (Number(row.tournaments_played) || 0),
        tournament_wins: acc.tournament_wins + (Number(row.tournaments_won) || 0),
      }),
      { hands_played: 0, tournaments_played: 0, tournament_wins: 0 }
    );

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
    },
    /** The club whose table produced these hands. `player_stats` is per club. */
    clubId?: string
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
      /**
       * THE KEY IS (user_id, club_id), AND BOTH HALVES OF THIS WERE WRONG.
       *
       * 2026-09-05. `onConflict: 'user_id'` names a constraint that does not
       * exist - the unique index is `player_stats_user_id_club_id_key` - and
       * the row was inserted with NO club_id at all. Then step 2 read the row
       * back with `.maybeSingle()`, which PGRST116s for any multi-club player
       * (963 of 1,310), so `existing` was null and THE INCREMENT NEVER RAN.
       * A player's counters simply stopped the day they joined a second club.
       *
       * Worse, had that read succeeded it would have written one club's total
       * across EVERY club row for the player: the update was scoped
       * `.eq('user_id', userId)` with no club filter.
       *
       * A per-club table needs a club. `clubId` is passed from the table that
       * dealt the hand; without one there is nothing truthful to write, so
       * this reports and returns rather than guessing a row.
       */
      if (!clubId) {
        reportError(
          new Error('player_stats increment attempted with no clubId'),
          'AchievementTriggerService.Stats_update_missing_club',
          { userId }
        );
        return;
      }

      const { data: existing, error: readErr } = await supabase
        .from('player_stats')
        .select('hands_played, tournaments_played, tournaments_won')
        .eq('user_id', userId)
        .eq('club_id', clubId)
        .maybeSingle();
      if (readErr) {
        reportError(readErr, 'AchievementTriggerService.Stats_read_failed');
        return;
      }

      const { error: writeErr } = await supabase.from('player_stats').upsert(
        {
          user_id: userId,
          club_id: clubId,
          hands_played: (existing?.hands_played || 0) + (increments.handsPlayed || 0),
          tournaments_played: (existing?.tournaments_played || 0) + (increments.tournaments || 0),
          tournaments_won: (existing?.tournaments_won || 0) + (increments.tournamentWins || 0),
        },
        { onConflict: 'user_id,club_id' }
      );
      if (writeErr) reportError(writeErr, 'AchievementTriggerService.Stats_update_failed');
    } catch (err) {
      console.debug('[AchievementTrigger] Stats update unexpected error:', err);
    }
  }
}

export const achievementTriggerService = new AchievementTriggerServiceClass();
export default achievementTriggerService;
