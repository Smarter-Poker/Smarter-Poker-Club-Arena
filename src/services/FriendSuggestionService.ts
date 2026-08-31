/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FRIEND SUGGESTION SERVICE — "People You May Know" Algorithm
 * ═══════════════════════════════════════════════════════════════════════════════
 * Generates friend suggestions based on:
 * - Shared club memberships
 * - Mutual friends
 * - Recent table opponents
 */

import { supabase } from '../lib/supabase';
import { blockService } from './BlockService';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface FriendshipRow {
  user_id?: string;
  friend_id?: string;
}

interface ProfileRow {
  id: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
  is_online?: boolean;
}

export interface FriendSuggestion {
  userId: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  isOnline: boolean;
  score: number;
  reasons: SuggestionReason[];
}

export interface SuggestionReason {
  type: 'mutual_friend' | 'shared_club' | 'recent_opponent';
  label: string;
  count?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class FriendSuggestionServiceClass {
  /**
   * Get friend suggestions for a user
   */
  async getSuggestions(userId: string, limit: number = 10): Promise<FriendSuggestion[]> {
    try {
      // Parallel: get existing friends, blocked users, and candidates
      const [friends, sharedClubUsers, recentOpponents] = await Promise.all([
        this.getExistingFriendIds(userId),
        this.getSharedClubUsers(userId),
        this.getRecentOpponents(userId),
      ]);

      // Merge and score candidates
      const candidates = new Map<string, FriendSuggestion>();

      // Score shared club members (+3 each shared club)
      for (const candidate of sharedClubUsers) {
        if (candidate.userId === userId || friends.has(candidate.userId)) continue;

        const existing = candidates.get(candidate.userId);
        if (existing) {
          existing.score += 3;
          const clubReason = existing.reasons.find((r) => r.type === 'shared_club');
          if (clubReason && clubReason.count) {
            clubReason.count++;
            clubReason.label = `${clubReason.count} shared clubs`;
          }
        } else {
          candidates.set(candidate.userId, {
            ...candidate,
            score: 3,
            reasons: [
              {
                type: 'shared_club',
                label: `Member Of ${candidate.clubName}`,
                count: 1,
              },
            ],
          });
        }
      }

      // Score recent opponents (+2 each session)
      for (const opponent of recentOpponents) {
        if (opponent.userId === userId || friends.has(opponent.userId)) continue;

        const existing = candidates.get(opponent.userId);
        if (existing) {
          existing.score += 2;
          existing.reasons.push({
            type: 'recent_opponent',
            label: 'Played Together Recently',
          });
        } else {
          candidates.set(opponent.userId, {
            ...opponent,
            score: 2,
            reasons: [
              {
                type: 'recent_opponent',
                label: 'Played Together Recently',
              },
            ],
          });
        }
      }

      // Filter out blocked users
      const results: FriendSuggestion[] = [];
      for (const suggestion of candidates.values()) {
        const isBlocked = await blockService.isEitherBlocked(userId, suggestion.userId);
        if (!isBlocked) {
          results.push(suggestion);
        }
      }

      // Sort by score descending
      results.sort((a, b) => b.score - a.score);
      return results.slice(0, limit);
    } catch (err: unknown) {
      reportError(err, 'FriendSuggestionService.getSuggestions');
      return [];
    }
  }

  /**
   * Get IDs of existing friends
   */
  private async getExistingFriendIds(userId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    try {
      const { data, error } = await supabase
        .from('friendships')
        .select('user_id, friend_id')
        .or(`user_id.eq.${userId},friend_id.eq.${userId}`)
        .eq('status', 'accepted');
      if (error) console.warn('[FriendSuggestions] getExistingFriendIds error:', error.message);
      (data || []).forEach((row: FriendshipRow) => {
        if (row.user_id && row.friend_id) {
          ids.add(row.user_id === userId ? row.friend_id : row.user_id);
        }
      });
    } catch (err: unknown) {
      console.warn(
        '[FriendSuggestions] getExistingFriendIds unexpected error:',
        err instanceof Error ? err.message : String(err)
      );
    }
    ids.add(userId); // exclude self
    return ids;
  }

  /**
   * Find users in the same clubs
   */
  private async getSharedClubUsers(
    userId: string
  ): Promise<(FriendSuggestion & { clubName: string })[]> {
    try {
      // Get user's clubs
      const { data: myClubs, error: cErr } = await supabase
        .from('club_members')
        .select('club_id, clubs(name)')
        .eq('user_id', userId);
      if (cErr) reportError(cErr, 'FriendSuggestionService.getSharedClubUsers_clubs_error');

      if (!myClubs || myClubs.length === 0) return [];

      const clubIds = myClubs.map((c: any) => c.club_id);
      const clubNames = new Map<string, string>();
      myClubs.forEach((c: any) => {
        clubNames.set(c.club_id, (c.clubs as any)?.name || 'Club');
      });

      // Get members of those clubs (excluding self)
      const { data: members, error: mErr } = await supabase
        .from('club_members')
        .select('user_id, club_id')
        .in('club_id', clubIds)
        .neq('user_id', userId)
        // ordered so the 100 suggestions are stable between refreshes rather
        // than a different arbitrary slice each time
        .order('joined_at', { ascending: false })
        .limit(100);
      if (mErr) reportError(mErr, 'FriendSuggestionService.getSharedClubUsers_members_error');

      // Batch-fetch profiles (no FK between club_members and profiles)
      const userIds = (members || []).map((m: any) => m.user_id);
      const profileMap: Record<string, ProfileRow> = {};
      if (userIds.length > 0) {
        try {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, username, display_name, avatar_url, is_online')
            .in('id', [...new Set(userIds)]);
          if (profiles) {
            for (const p of profiles) profileMap[p.id] = p as ProfileRow;
          }
        } catch (e) {
          reportError(e, 'FriendSuggestionService.userIds');
          /* non-critical */
        }
      }

      return (members || []).map((m: any) => {
        const userId = m.user_id as string;
        return {
          userId,
          username: profileMap[userId]?.username || 'Unknown',
          displayName: profileMap[userId]?.display_name ?? undefined,
          avatarUrl: profileMap[userId]?.avatar_url ?? undefined,
          isOnline: profileMap[userId]?.is_online || false,
          score: 0,
          reasons: [],
          clubName: clubNames.get(m.club_id) || 'Club',
        };
      });
    } catch (err: unknown) {
      console.warn(
        '[FriendSuggestions] getSharedClubUsers unexpected error:',
        err instanceof Error ? err.message : String(err)
      );
      return [];
    }
  }

  /**
   * Find recent table opponents (last 7 days)
   */
  private async getRecentOpponents(userId: string): Promise<FriendSuggestion[]> {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

      // 2026-08-19: this read `hand_players`, which has ZERO rows in
      // production — so "people you recently played with" never returned a
      // single suggestion. table_seats is the live record of who sat where and
      // answers the same question directly (and more cheaply: seats, not hands).
      const { data: mySeats, error: hErr } = await supabase
        .from('table_seats')
        .select('table_id')
        .eq('user_id', userId)
        .gte('joined_at', sevenDaysAgo)
        .limit(QUERY_LIMITS.LIST);
      if (hErr) reportError(hErr, 'FriendSuggestionService.getRecentOpponents_hands_error');

      if (!mySeats || mySeats.length === 0) return [];

      const tableIds = Array.from(
        new Set(mySeats.map((s: { table_id: string }) => s.table_id).filter(Boolean))
      );
      if (tableIds.length === 0) return [];

      // Other people at those tables. Horses are house AI — suggesting them as
      // friends would fill the list with opponents who are not people.
      const { data: opponents, error: oErr } = await supabase
        .from('table_seats')
        .select(
          `
          user_id,
          profiles:user_id!inner(username, display_name, avatar_url, is_online, is_horse)
        `
        )
        .in('table_id', tableIds)
        .neq('user_id', userId)
        .gte('joined_at', sevenDaysAgo)
        .eq('profiles.is_horse', false)
        .limit(50);
      if (oErr) reportError(oErr, 'FriendSuggestionService.getRecentOpponents_opponents_error');

      // Dedupe by user_id
      const seen = new Set<string>();
      return (opponents || [])
        .filter((o: any) => {
          if (seen.has(o.user_id)) return false;
          seen.add(o.user_id);
          return true;
        })
        .map((o: any) => ({
          userId: o.user_id as string,
          username: o.profiles?.username || 'Unknown',
          displayName: o.profiles?.display_name ?? undefined,
          avatarUrl: o.profiles?.avatar_url ?? undefined,
          isOnline: o.profiles?.is_online || false,
          score: 0,
          reasons: [],
        }));
    } catch (err: unknown) {
      console.warn(
        '[FriendSuggestions] getRecentOpponents unexpected error:',
        err instanceof Error ? err.message : String(err)
      );
      return [];
    }
  }

  /**
   * Get mutual friends between two users
   */
  async getMutualFriends(
    userId: string,
    otherUserId: string
  ): Promise<{ id: string; username: string; avatarUrl?: string }[]> {
    try {
      // Get friends of userId
      const { data: myFriends } = await supabase
        .from('friendships')
        .select('user_id, friend_id')
        .or(`user_id.eq.${userId},friend_id.eq.${userId}`)
        .eq('status', 'accepted');

      const myFriendIds = new Set<string>();
      (myFriends || []).forEach((row: any) => {
        if (row.user_id && row.friend_id) {
          myFriendIds.add(row.user_id === userId ? row.friend_id : row.user_id);
        }
      });

      // Get friends of otherUserId
      const { data: theirFriends } = await supabase
        .from('friendships')
        .select('user_id, friend_id')
        .or(`user_id.eq.${otherUserId},friend_id.eq.${otherUserId}`)
        .eq('status', 'accepted');

      const theirFriendIds = new Set<string>();
      (theirFriends || []).forEach((row: any) => {
        if (row.user_id && row.friend_id) {
          theirFriendIds.add(row.user_id === otherUserId ? row.friend_id : row.user_id);
        }
      });

      // Intersection
      const mutualIds = [...myFriendIds].filter((id) => theirFriendIds.has(id));
      if (mutualIds.length === 0) return [];

      // Fetch profiles
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, username, avatar_url')
        .in('id', mutualIds);

      return (profiles || []).map((p: any) => ({
        id: p.id as string,
        username: p.username as string,
        avatarUrl: p.avatar_url as string | undefined,
      }));
    } catch (err: unknown) {
      reportError(err, 'FriendSuggestionService.getMutualFriends');
      return [];
    }
  }
}

// Export singleton
export const friendSuggestionService = new FriendSuggestionServiceClass();
