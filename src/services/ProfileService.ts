/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PROFILE SERVICE — User Profile Management
 * Handles VIP levels, streaks, and avatars
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';

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

export interface ProfileStats {
  totalHands: number;
  winRate: number;
  avgProfit: number;
  biggestWin: number;
  favoriteVariant: string;
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
          'id, username, display_name, avatar_url, bio, level, tier, xp, login_streak, streak_days, last_login_date, total_hands_played, diamonds, created_at, updated_at'
        )
        .eq('id', userId)
        .maybeSingle();

      if (error || !data) return null;

      return this.mapProfile(data);
    } catch (err: unknown) {
      console.error('[Profile] getProfile error:', err);
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
          'id, username, display_name, avatar_url, bio, level, tier, xp, login_streak, streak_days, last_login_date, total_hands_played, diamonds, created_at, updated_at'
        )
        .eq('username', username)
        .maybeSingle();

      if (error || !data) return null;

      return this.mapProfile(data);
    } catch (err: unknown) {
      console.error('[Profile] getProfileByUsername error:', err);
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
          level, tier, xp,
          login_streak, streak_days,
          total_hands_played, diamonds,
          created_at, updated_at
        `
        )
        .eq('id', userId)
        .maybeSingle();

      if (error || !data) return null;
      return this.mapProfile(data);
    } catch (err: unknown) {
      console.error('[Profile] getPublicProfile error:', err);
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
      console.error('[Profile] VIP points update failed:', vipErr);
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
          current_streak: currentStreak,
          longest_streak: longestStreak,
          last_login_date: new Date().toISOString(), // FIX: was `last_login` — column is `last_login_date`
        })
        .eq('id', userId);

      if (streakErr) {
        console.error('[Profile] Streak update failed:', streakErr);
      }

      masterBus.emit('PROFILE_UPDATED', {
        userId,
        updates: { currentStreak, longestStreak } as unknown as Record<string, unknown>,
      });
    }

    return { currentStreak, isNewDay };
  }

  /**
   * Get player stats
   */
  async getStats(userId: string): Promise<ProfileStats | null> {
    // Get player hand results from hand_players (joined to hands for variant)
    const { data } = await supabase
      .from('hand_players')
      .select('chips_won, chips_lost, is_winner, hands(game_type)')
      .eq('user_id', userId)
      .limit(5000);

    if (!data || data.length === 0) {
      return {
        totalHands: 0,
        winRate: 0,
        avgProfit: 0,
        biggestWin: 0,
        favoriteVariant: "No Limit Hold'em",
      };
    }

    const totalHands = data.length;
    const wins = data.filter((h: any) => h.is_winner).length;
    const winRate = totalHands > 0 ? (wins / totalHands) * 100 : 0;
    const profits = data.map((h: any) => (h.chips_won || 0) - (h.chips_lost || 0));
    const avgProfit =
      totalHands > 0 ? profits.reduce((sum: number, p: number) => sum + p, 0) / totalHands : 0;
    const biggestWin = Math.max(...profits, 0);

    // Find favorite variant from joined hands data
    const variantCounts: Record<string, number> = {};
    data.forEach((h: any) => {
      const variant = h.hands?.game_type || 'NLH';
      variantCounts[variant] = (variantCounts[variant] || 0) + 1;
    });
    const favoriteVariant =
      Object.entries(variantCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "No Limit Hold'em";

    return {
      totalHands,
      winRate: Math.trunc(winRate * 10) / 10,
      avgProfit: Math.trunc(avgProfit * 100) / 100,
      biggestWin,
      favoriteVariant,
    };
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
        'id, username, display_name, avatar_url, level, tier, xp, total_hands_played, diamonds, created_at, updated_at'
      )
      .order(orderColumn, { ascending: false })
      .limit(limit);

    return (data || []).map(this.mapProfile);
  }

  /**
   * Check if user has accepted Club Arena TOS
   */
  async hasTOSAccepted(userId: string): Promise<boolean> {
    try {
      // club_arena_tos_accepted_at column doesn't exist in profiles yet.
      // Check preferences JSONB field as fallback, or default to true to avoid blocking users.
      const { data, error } = await supabase
        .from('profiles')
        .select('preferences')
        .eq('id', userId)
        .maybeSingle();

      if (error || !data) return true; // Default to accepted if query fails
      const prefs = data.preferences as Record<string, unknown> | null;
      return !!prefs?.club_arena_tos_accepted; // FIX: was returning true in both branches
    } catch (err: unknown) {
      console.error('[Profile] hasTOSAccepted error:', err);
      return true; // Default to accepted to avoid blocking
    }
  }

  /**
   * Accept Club Arena TOS
   */
  async acceptTOS(userId: string): Promise<boolean> {
    // club_arena_tos_accepted_at column doesn't exist yet — store in preferences JSONB
    // FIX: Merge with existing preferences instead of overwriting the entire JSONB field
    const { data: existing } = await supabase
      .from('profiles')
      .select('preferences')
      .eq('id', userId)
      .maybeSingle();
    const currentPrefs = (existing?.preferences as Record<string, unknown>) || {};
    const { error } = await supabase
      .from('profiles')
      .update({
        preferences: {
          ...currentPrefs,
          club_arena_tos_accepted: true,
          tos_accepted_at: new Date().toISOString(),
        },
      })
      .eq('id', userId);

    if (error) {
      console.error('[TOS] Failed to accept TOS:', error);
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
      vipPoints: (data.xp as number) || 0, // No vip_points column; use xp as proxy
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
