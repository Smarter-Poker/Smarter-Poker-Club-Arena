/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BLOCK SERVICE — Player Blocking & Muting
 * ═══════════════════════════════════════════════════════════════════════════════
 * Allows players to block/unblock other players at the social level.
 * Blocked users cannot send DMs, friend requests, or appear in suggestions.
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BlockedUser {
  id: string;
  blockedUserId: string;
  blockedUsername: string;
  blockedAvatar?: string;
  reason?: string;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class BlockServiceClass {
  /** In-memory cache for fast isBlocked checks */
  private blockedIds: Set<string> = new Set();
  private cacheUserId: string | null = null;

  /**
   * Block a user
   */
  async blockUser(userId: string, targetUserId: string, reason?: string): Promise<boolean> {
    try {
      const { error } = await supabase.from('user_blocks').insert({
        blocker_id: userId,
        blocked_id: targetUserId,
        reason: reason || null,
      });

      if (error) {
        // Unique constraint — already blocked
        if (error.code === '23505') return true;
        console.error('[BlockService] Failed to block user:', error);
        return false;
      }

      // Update cache
      this.blockedIds.add(targetUserId);

      // Remove friendship if exists
      await supabase
        .from('friendships')
        .delete()
        .or(
          `and(user_id.eq.${userId},friend_id.eq.${targetUserId}),and(user_id.eq.${targetUserId},friend_id.eq.${userId})`
        );

      masterBus.emit('USER_BLOCKED', {
        userId,
        blockedUserId: targetUserId,
      });

      return true;
    } catch (err: unknown) {
      console.error('[BlockService] blockUser error:', err);
      return false;
    }
  }

  /**
   * Unblock a user
   */
  async unblockUser(userId: string, targetUserId: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('user_blocks')
        .delete()
        .eq('blocker_id', userId)
        .eq('blocked_id', targetUserId);

      if (error) {
        console.error('[BlockService] Failed to unblock user:', error);
        return false;
      }

      // Update cache
      this.blockedIds.delete(targetUserId);

      masterBus.emit('USER_UNBLOCKED', {
        userId,
        unblockedUserId: targetUserId,
      });

      return true;
    } catch (err: unknown) {
      console.error('[BlockService] unblockUser error:', err);
      return false;
    }
  }

  /**
   * Get all blocked users for a user
   */
  async getBlockedUsers(userId: string): Promise<BlockedUser[]> {
    try {
      const { data, error } = await supabase
        .from('user_blocks')
        .select(
          `
          id,
          blocked_id,
          reason,
          created_at,
          profiles:blocked_id(username, avatar_url)
        `
        )
        .eq('blocker_id', userId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('[BlockService] Failed to get blocked users:', error);
        return [];
      }

      return (data || []).map((row: any) => ({
        id: row.id,
        blockedUserId: row.blocked_id,
        blockedUsername: row.profiles?.username || 'Unknown',
        blockedAvatar: row.profiles?.avatar_url,
        reason: row.reason,
        createdAt: row.created_at,
      }));
    } catch (err: unknown) {
      console.error('[BlockService] getBlockedUsers error:', err);
      return [];
    }
  }

  /**
   * Check if a user is blocked (fast, uses cache)
   */
  async isBlocked(userId: string, targetUserId: string): Promise<boolean> {
    // Warm cache on first check
    if (this.cacheUserId !== userId) {
      await this.warmCache(userId);
    }
    return this.blockedIds.has(targetUserId);
  }

  /**
   * Check if target has blocked the user (reverse check)
   */
  async isBlockedBy(userId: string, targetUserId: string): Promise<boolean> {
    const { count, error } = await supabase
      .from('user_blocks')
      .select('*', { count: 'exact', head: true })
      .eq('blocker_id', targetUserId)
      .eq('blocked_id', userId);

    if (error) return false;
    return (count || 0) > 0;
  }

  /**
   * Bidirectional block check — returns true if either user has blocked the other
   */
  async isEitherBlocked(userId: string, targetUserId: string): Promise<boolean> {
    const [blocked, blockedBy] = await Promise.all([
      this.isBlocked(userId, targetUserId),
      this.isBlockedBy(userId, targetUserId),
    ]);
    return blocked || blockedBy;
  }

  /**
   * Warm the blocked-IDs cache for a user
   */
  private async warmCache(userId: string): Promise<void> {
    try {
      const { data } = await supabase
        .from('user_blocks')
        .select('blocked_id')
        .eq('blocker_id', userId);

      this.blockedIds = new Set((data || []).map((row: any) => row.blocked_id));
      this.cacheUserId = userId;
    } catch (err) {
      console.error('[BlockService] Error:', err);
      this.blockedIds = new Set();
    }
  }

  /**
   * Invalidate cache (call after login/logout)
   */
  invalidateCache(): void {
    this.blockedIds.clear();
    this.cacheUserId = null;
  }
}

// Export singleton
export const blockService = new BlockServiceClass();
