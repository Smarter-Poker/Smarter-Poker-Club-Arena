/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PROFILE SERVICE — User Profile Management
 * Handles VIP levels, streaks, and avatars
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface UserProfile {
  id: string;
  userId: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  bio?: string;

  // Leveling
  level: number;

  // VIP
  vipTier: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';
  vipPoints: number;

  // Streaks
  currentStreak: number;
  longestStreak: number;
  lastLoginDate?: string;

  // Stats
  handsPlayed: number;
  tournamentsWon: number;
  totalWinnings: number;

  // Timestamps
  createdAt: string;
  updatedAt: string;
}

// VIP thresholds
const VIP_THRESHOLDS = {
  bronze: 0,
  silver: 1000,
  gold: 5000,
  platinum: 25000,
  diamond: 100000,
};

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class ProfileServiceClass {
  /**
   * Get user profile
   */
  async getProfile(userId: string): Promise<UserProfile | null> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select(
          'id, username, display_name, avatar_url, bio, level, tier, login_streak, streak_days, last_login_date, total_hands_played, diamonds, created_at, updated_at'
        )
        .eq('id', userId)
        .maybeSingle();

      if (error || !data) return null;

      return this.mapProfile(data);
    } catch (err: unknown) {
      reportError(err, 'ProfileService.getProfile', { userId });
      return null;
    }
  }

  /**
   * Get profile by username
   */
  async getProfileByUsername(username: string): Promise<UserProfile | null> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select(
          'id, username, display_name, avatar_url, bio, level, tier, login_streak, streak_days, last_login_date, total_hands_played, diamonds, created_at, updated_at'
        )
        .eq('username', username)
        .maybeSingle();

      if (error || !data) return null;

      return this.mapProfile(data);
    } catch (err: unknown) {
      reportError(err, 'ProfileService.getProfileByUsername', { username });
      return null;
    }
  }

  /**
   * Get a public-facing profile for another user (limited fields)
   */
  async getPublicProfile(userId: string): Promise<UserProfile | null> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select(
          `
          id, username, display_name, avatar_url, bio,
          level, tier,
          created_at, updated_at
        `
        )
        .eq('id', userId)
        .maybeSingle();

      if (error || !data) return null;
      return this.mapProfile(data);
    } catch (err: unknown) {
      reportError(err, 'ProfileService.getPublicProfile', { userId });
      return null;
    }
  }

  /**
   * Update profile
   */
  async updateProfile(
    userId: string,
    updates: Partial<{
      displayName: string;
      bio: string;
      avatarUrl: string;
    }>
  ): Promise<boolean> {
    const dbUpdates: Record<string, unknown> = {};
    if (updates.displayName !== undefined) dbUpdates.display_name = updates.displayName;
    if (updates.bio !== undefined) dbUpdates.bio = updates.bio;
    if (updates.avatarUrl !== undefined) dbUpdates.avatar_url = updates.avatarUrl;

    const { error } = await supabase.from('profiles').update(dbUpdates).eq('id', userId);

    if (!error) {
      masterBus.emit('PROFILE_UPDATED', {
        userId,
        updates: updates as unknown as Record<string, unknown>,
      });
    }
    return !error;
  }

  /**
   * Add VIP points
   */
  async addVIPPoints(
    userId: string,
    points: number
  ): Promise<{ newPoints: number; newTier: string }> {
    const profile = await this.getProfile(userId);
    if (!profile) throw new Error('Profile not found');

    const newPoints = profile.vipPoints + points;
    let newTier = profile.vipTier;

    // Check for tier upgrade
    if (newPoints >= VIP_THRESHOLDS.diamond) newTier = 'diamond';
    else if (newPoints >= VIP_THRESHOLDS.platinum) newTier = 'platinum';
    else if (newPoints >= VIP_THRESHOLDS.gold) newTier = 'gold';
    else if (newPoints >= VIP_THRESHOLDS.silver) newTier = 'silver';

    const { error: vipErr } = await supabase
      .from('profiles')
      .update({ tier: newTier })
      .eq('id', userId);

    if (vipErr) {
      reportError(vipErr, 'ProfileService.addVIPPoints', { userId, points });
      throw new Error('Failed to update VIP points');
    }

    masterBus.emit('PROFILE_UPDATED', {
      userId,
      updates: { vipPoints: newPoints, vipTier: newTier } as unknown as Record<string, unknown>,
    });

    return { newPoints, newTier };
  }

  /**
   * Update daily streak
   */
  async updateStreak(userId: string): Promise<{ currentStreak: number; isNewDay: boolean }> {
    const profile = await this.getProfile(userId);
    if (!profile) throw new Error('Profile not found');

    const today = new Date().toISOString().split('T')[0];
    const lastLogin = profile.lastLoginDate?.split('T')[0];

    let currentStreak = profile.currentStreak;
    let isNewDay = false;

    if (lastLogin !== today) {
      isNewDay = true;
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

      if (lastLogin === yesterday) {
        // Consecutive day - increment streak
        currentStreak++;
      } else {
        // Streak broken - reset to 1
        currentStreak = 1;
      }

      const longestStreak = Math.max(currentStreak, profile.longestStreak);

      const { error: streakErr } = await supabase
        .from('profiles')
        .update({
          // The columns are `login_streak` and `streak_days`; the mapper below
          // has always read them under those names. Writing `current_streak`
          // and `longest_streak` was rejected every time, so a streak could be
          // computed and displayed for one render and never persisted.
          login_streak: currentStreak,
          streak_days: longestStreak,
          last_login_date: new Date().toISOString(), // FIX: was `last_login` — column is `last_login_date`
        })
        .eq('id', userId);

      if (streakErr) {
        reportError(streakErr, 'ProfileService.updateStreak', { userId });
      }

      masterBus.emit('PROFILE_UPDATED', {
        userId,
        updates: { currentStreak, longestStreak } as unknown as Record<string, unknown>,
      });
    }

    return { currentStreak, isNewDay };
  }

  /**
   * Get leaderboard
   */
  async getLeaderboard(metric: 'winnings' | 'hands', limit: number = 10): Promise<UserProfile[]> {
    const orderColumn = {
      winnings: 'diamonds', // No total_winnings column; use diamonds as proxy
      hands: 'total_hands_played',
    }[metric];

    const { data } = await supabase
      .from('profiles')
      .select(
        'id, username, display_name, avatar_url, level, tier, total_hands_played, diamonds, created_at, updated_at'
      )
      .order(orderColumn, { ascending: false })
      .limit(limit);

    return (data || []).map(this.mapProfile);
  }

  /**
   * Whether this user has accepted the Club Arena Terms of Service.
   *
   * 2026-08-16: THIS READ WAS LOOKING IN THE WRONG PLACE.
   *
   * It read `preferences.club_arena_tos_accepted`, a JSONB flag that only
   * `acceptTOS()` below ever wrote. The real, canonical record of acceptance is
   * the `profiles.club_arena_tos_accepted_at` COLUMN — that is what the World
   * Hub acceptance endpoint (`/api/club-arena/accept-tos`) writes and what the
   * seat gate reads. The stale comment claiming the column "doesn't exist in
   * profiles yet" had outlived the column by some margin: it is a
   * `timestamptz` and has been there all along.
   *
   * So Club Arena and World Hub each kept their own private answer to the same
   * legal question, in different places, and neither could see the other's.
   *
   * Returns a tri-state rather than a boolean because "we asked and they have
   * not accepted" and "we could not ask" are different facts, and the right
   * response to each is a caller's decision, not this function's. Collapsing
   * them is how the previous version ended up treating a network blip as
   * consent.
   */
  async getTOSStatus(userId: string): Promise<'accepted' | 'not_accepted' | 'unknown'> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('club_arena_tos_accepted_at')
        .eq('id', userId)
        .maybeSingle();

      if (error) {
        reportError(error, 'ProfileService.getTOSStatus', { userId });
        return 'unknown';
      }
      // A missing profile row is not an error and not consent. It is a user we
      // have no acceptance on file for.
      return data?.club_arena_tos_accepted_at ? 'accepted' : 'not_accepted';
    } catch (err: unknown) {
      reportError(err, 'ProfileService.getTOSStatus', { userId });
      return 'unknown';
    }
  }

  /**
   * Convenience wrapper over {@link getTOSStatus}.
   *
   * FAILS CLOSED: only a recorded acceptance returns true. The previous version
   * returned `true` on a missing row AND on a query failure — "default to
   * accepted to avoid blocking" — which meant an RLS change, a dropped
   * connection or a typo'd column silently waved every user past the consent
   * gate. A legal consent check is the one place a convenient default is not
   * available to us.
   *
   * Callers that would rather degrade than block on a transient failure should
   * call `getTOSStatus()` and handle 'unknown' deliberately.
   */
  async hasTOSAccepted(userId: string): Promise<boolean> {
    return (await this.getTOSStatus(userId)) === 'accepted';
  }

  /**
   * Record this user's acceptance of the Club Arena Terms of Service.
   *
   * 2026-08-16: writes the CANONICAL column, not a private JSONB flag.
   *
   * This used to merge `club_arena_tos_accepted: true` into `preferences`,
   * which no other system reads. World Hub's `/api/club-arena/accept-tos`
   * stamps `profiles.club_arena_tos_accepted_at`, and the seat gate reads that
   * column — so an acceptance recorded here was invisible to the only place
   * that enforces it. Both writers now agree.
   *
   * The read-then-merge of `preferences` is gone with it: it was only there to
   * avoid clobbering the JSONB, and a plain column write cannot clobber
   * anything.
   */
  async acceptTOS(userId: string): Promise<boolean> {
    const { error } = await supabase
      .from('profiles')
      .update({ club_arena_tos_accepted_at: new Date().toISOString() })
      .eq('id', userId);

    if (error) {
      reportError(error, 'ProfileService.acceptTOS', { userId });
      return false;
    }

    masterBus.emit('PROFILE_UPDATED', {
      userId,
      updates: { tosAccepted: true } as unknown as Record<string, unknown>,
    });

    return true;
  }

  /**
   * Map database record to UserProfile
   */
  private mapProfile(data: Record<string, unknown>): UserProfile {
    const level = (data.level as number) || 1;
    return {
      id: data.id as string,
      userId: data.id as string,
      username: data.username as string,
      displayName: data.display_name as string | undefined,
      avatarUrl: data.avatar_url as string | undefined,
      bio: data.bio as string | undefined,
      level,
      vipTier: (data.tier as UserProfile['vipTier']) || 'bronze', // DB column is `tier`
      vipPoints: 0, // there is no points column; VIP is tier-only
      currentStreak: (data.login_streak as number) || 0, // DB column is `login_streak`
      longestStreak: (data.streak_days as number) || 0, // DB column is `streak_days`
      lastLoginDate: data.last_login_date as string | undefined,
      handsPlayed: (data.total_hands_played as number) || 0, // DB column is `total_hands_played`
      tournamentsWon: 0, // No tournaments_won column in DB
      totalWinnings: (data.diamonds as number) || 0, // No total_winnings column; use diamonds
      createdAt: data.created_at as string,
      updatedAt: data.updated_at as string,
    };
  }
}

// Export singleton
export const profileService = new ProfileServiceClass();
