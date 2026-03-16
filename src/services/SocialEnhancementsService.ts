/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SOCIAL ENHANCEMENTS SERVICE — Q3 Phase 14
 *  Kudos, Stories, Connection Strength, Social Feed, Club Online, Join Requests,
 *  Rich Push, Player Graph, Friend Online Count, Rich Text Rendering
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface KudosEntry {
  id: string;
  fromUserId: string;
  toUserId: string;
  type: 'good_opponent' | 'great_player' | 'fun_table' | 'fair_play';
  createdAt: string;
}

export interface PlayerStory {
  id: string;
  userId: string;
  username: string;
  avatarUrl?: string;
  content: string;
  imageUrl?: string;
  expiresAt: string;
  createdAt: string;
  viewCount: number;
  isExpired: boolean;
}

export interface SocialFeedItem {
  id: string;
  userId: string;
  username: string;
  avatarUrl?: string;
  type:
    | 'hand_result'
    | 'tournament_finish'
    | 'achievement'
    | 'level_up'
    | 'club_join'
    | 'kudos_received'
    | 'story';
  title: string;
  description: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ConnectionStrength {
  sharedClubs: number;
  sharedTables: number;
  mutualFriends: number;
  totalKudos: number;
  strength: 'weak' | 'moderate' | 'strong' | 'best_friend';
}

export interface JoinRequest {
  id: string;
  clubId: string;
  clubName: string;
  userId: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

class SocialEnhancementsServiceClass {
  // ═══════════════════════════════════════════════════════════════════════════
  // KUDOS / PLAYER REPUTATION
  // ═══════════════════════════════════════════════════════════════════════════

  /** Send kudos to another player after a shared session */
  async sendKudos(
    fromUserId: string,
    toUserId: string,
    type: KudosEntry['type']
  ): Promise<boolean> {
    const { error } = await supabase.from('player_kudos').insert({
      from_user_id: fromUserId,
      to_user_id: toUserId,
      type,
    });

    if (!error) {
      masterBus.emit('NOTIFICATION_RECEIVED', {
        notification: { type: 'kudos', fromUserId, toUserId, kudosType: type },
      });
    }
    return !error;
  }

  /** Get kudos count for a player */
  async getKudosCount(userId: string): Promise<Record<KudosEntry['type'], number>> {
    const counts: Record<string, number> = {
      good_opponent: 0,
      great_player: 0,
      fun_table: 0,
      fair_play: 0,
    };
    try {
      const { data, error } = await supabase
        .from('player_kudos')
        .select('type')
        .eq('to_user_id', userId);
      if (error) console.warn('[Social] getKudosCount error:', error.message);
      (data || []).forEach((k: any) => {
        counts[k.type] = (counts[k.type] || 0) + 1;
      });
    } catch (err) {
      console.warn('[Social] getKudosCount unexpected error:', err);
    }
    return counts as Record<KudosEntry['type'], number>;
  }

  /** Get total kudos for a player */
  async getTotalKudos(userId: string): Promise<number> {
    try {
      const { count, error } = await supabase
        .from('player_kudos')
        .select('id', { count: 'exact', head: true })
        .eq('to_user_id', userId);
      if (error) console.warn('[Social] getTotalKudos error:', error.message);
      return count || 0;
    } catch (err) {
      console.warn('[Social] getTotalKudos unexpected error:', err);
      return 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLAYER STORIES / STATUS UPDATES
  // ═══════════════════════════════════════════════════════════════════════════

  /** Post a story (expires after 24h) */
  async postStory(userId: string, content: string, imageUrl?: string): Promise<string | null> {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('player_stories')
      .insert({
        user_id: userId,
        content,
        image_url: imageUrl,
        expires_at: expiresAt,
      })
      .select('id')
      .maybeSingle();

    return error || !data ? null : data.id;
  }

  /** Get active stories from friends */
  async getFriendStories(userId: string): Promise<{ data: PlayerStory[]; error?: string }> {
    try {
      // Get friend IDs
      const { data: friendships, error: fErr } = await supabase
        .from('friendships')
        .select('user_id, friend_id')
        .or(`user_id.eq.${userId},friend_id.eq.${userId}`)
        .eq('status', 'accepted');
      if (fErr) {
        console.error('[Social] getFriendStories friendships error:', fErr.message);
        return { data: [], error: `Failed to load friendships: ${fErr.message}` };
      }

      const friendIds = (friendships || []).map((f: any) =>
        f.user_id === userId ? f.friend_id : f.user_id
      );
      if (friendIds.length === 0) return { data: [] };

      const { data, error: sErr } = await supabase
        .from('player_stories')
        .select('*, profiles:user_id(username, avatar_url)')
        .in('user_id', friendIds)
        .gte('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(50);
      if (sErr) {
        console.error('[Social] getFriendStories stories error:', sErr.message);
        return { data: [], error: `Failed to load stories: ${sErr.message}` };
      }

      return {
        data: (data || []).map((s: any) => ({
          id: s.id,
          userId: s.user_id,
          username: s.profiles?.username || 'Unknown',
          avatarUrl: s.profiles?.avatar_url,
          content: s.content,
          imageUrl: s.image_url,
          expiresAt: s.expires_at,
          createdAt: s.created_at,
          viewCount: s.view_count || 0,
          isExpired: new Date(s.expires_at) < new Date(),
        })),
      };
    } catch (err) {
      console.error('[Social] getFriendStories unexpected error:', err);
      return { data: [], error: 'Unexpected error loading stories' };
    }
  }

  /** View a story (increment view count) */
  async viewStory(storyId: string): Promise<void> {
    try {
      const { error } = await supabase.rpc('increment_story_view', { story_id: storyId });
      if (error) console.warn('[Social] viewStory error:', error.message);
    } catch (err) {
      console.warn('[Social] viewStory unexpected error:', err);
    }
  }

  /** Delete own story */
  async deleteStory(storyId: string, userId: string): Promise<boolean> {
    const { error } = await supabase
      .from('player_stories')
      .delete()
      .eq('id', storyId)
      .eq('user_id', userId);
    return !error;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONNECTION STRENGTH
  // ═══════════════════════════════════════════════════════════════════════════

  /** Calculate connection strength between two players */
  async getConnectionStrength(userId: string, otherUserId: string): Promise<ConnectionStrength> {
    try {
      // Shared clubs
      const [{ data: myClubs, error: e1 }, { data: theirClubs, error: e2 }] = await Promise.all([
        supabase.from('club_members').select('club_id').eq('user_id', userId),
        supabase.from('club_members').select('club_id').eq('user_id', otherUserId),
      ]);
      if (e1) console.warn('[Social] getConnectionStrength myClubs error:', e1.message);
      if (e2) console.warn('[Social] getConnectionStrength theirClubs error:', e2.message);

      const myClubIds = new Set((myClubs || []).map((c: any) => c.club_id));
      const sharedClubs = (theirClubs || []).filter((c: any) => myClubIds.has(c.club_id)).length;

      // Shared tables (recent 30 days)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
      const { count: sharedTables, error: e3 } = await supabase
        .from('hand_history')
        .select('id', { count: 'exact', head: true })
        .contains('player_ids', [userId, otherUserId])
        .gte('created_at', thirtyDaysAgo);
      if (e3) console.warn('[Social] getConnectionStrength sharedTables error:', e3.message);

      // Mutual friends
      const [{ data: myFriends, error: e4 }, { data: theirFriends, error: e5 }] = await Promise.all(
        [
          supabase
            .from('friendships')
            .select('user_id, friend_id')
            .or(`user_id.eq.${userId},friend_id.eq.${userId}`)
            .eq('status', 'accepted'),
          supabase
            .from('friendships')
            .select('user_id, friend_id')
            .or(`user_id.eq.${otherUserId},friend_id.eq.${otherUserId}`)
            .eq('status', 'accepted'),
        ]
      );
      if (e4) console.warn('[Social] getConnectionStrength myFriends error:', e4.message);
      if (e5) console.warn('[Social] getConnectionStrength theirFriends error:', e5.message);

      const myFriendIds = new Set(
        (myFriends || []).map((f: any) => (f.user_id === userId ? f.friend_id : f.user_id))
      );
      const mutualFriends = (theirFriends || []).filter((f: any) => {
        const theirFriendId = f.user_id === otherUserId ? f.friend_id : f.user_id;
        return myFriendIds.has(theirFriendId);
      }).length;

      // Kudos exchanged
      const { count: totalKudos, error: e6 } = await supabase
        .from('player_kudos')
        .select('id', { count: 'exact', head: true })
        .or(
          `and(from_user_id.eq.${userId},to_user_id.eq.${otherUserId}),and(from_user_id.eq.${otherUserId},to_user_id.eq.${userId})`
        );
      if (e6) console.warn('[Social] getConnectionStrength kudos error:', e6.message);

      // Calculate strength tier
      const score =
        sharedClubs * 3 + (sharedTables || 0) + mutualFriends * 2 + (totalKudos || 0) * 2;
      let strength: ConnectionStrength['strength'] = 'weak';
      if (score >= 20) strength = 'best_friend';
      else if (score >= 10) strength = 'strong';
      else if (score >= 4) strength = 'moderate';

      return {
        sharedClubs,
        sharedTables: sharedTables || 0,
        mutualFriends,
        totalKudos: totalKudos || 0,
        strength,
      };
    } catch (err) {
      console.warn('[Social] getConnectionStrength unexpected error:', err);
      return { sharedClubs: 0, sharedTables: 0, mutualFriends: 0, totalKudos: 0, strength: 'weak' };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SOCIAL FEED ENRICHMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /** Get enriched social feed for a user (friend activity) */
  async getEnrichedSocialFeed(
    userId: string,
    limit = 30
  ): Promise<{ data: SocialFeedItem[]; error?: string }> {
    try {
      // Get friend IDs
      const { data: friendships, error: fErr } = await supabase
        .from('friendships')
        .select('user_id, friend_id')
        .or(`user_id.eq.${userId},friend_id.eq.${userId}`)
        .eq('status', 'accepted');
      if (fErr) {
        console.error('[Social] getEnrichedSocialFeed friendships error:', fErr.message);
        return { data: [], error: `Failed to load friendships: ${fErr.message}` };
      }

      const friendIds = (friendships || []).map((f: any) =>
        f.user_id === userId ? f.friend_id : f.user_id
      );
      if (friendIds.length === 0) return { data: [] };

      const items: SocialFeedItem[] = [];

      // Parallel fetch: achievements, tournament results, kudos
      const [achRes, tourneyRes, kudosRes] = await Promise.all([
        supabase
          .from('user_achievements')
          .select('*, profiles:user_id(username, avatar_url)')
          .in('user_id', friendIds)
          .order('unlocked_at', { ascending: false })
          .limit(10),
        supabase
          .from('tournament_players')
          .select('*, profiles:user_id(username, avatar_url), tournaments:tournament_id(name)')
          .in('user_id', friendIds)
          .not('finish_position', 'is', null)
          .order('updated_at', { ascending: false })
          .limit(10),
        supabase
          .from('player_kudos')
          .select(
            '*, from_profile:from_user_id(username), to_profile:to_user_id(username, avatar_url)'
          )
          .in('to_user_id', friendIds)
          .order('created_at', { ascending: false })
          .limit(10),
      ]);

      if (achRes.error) console.warn('[Social] feed achievements error:', achRes.error.message);
      if (tourneyRes.error)
        console.warn('[Social] feed tournaments error:', tourneyRes.error.message);
      if (kudosRes.error) console.warn('[Social] feed kudos error:', kudosRes.error.message);

      // Achievements
      (achRes.data || []).forEach((a: any) => {
        items.push({
          id: `ach-${a.id}`,
          userId: a.user_id,
          username: a.profiles?.username || 'Unknown',
          avatarUrl: a.profiles?.avatar_url,
          type: 'achievement',
          title: `${a.profiles?.username} unlocked an achievement!`,
          description: a.achievement_name || a.name || 'New achievement',
          createdAt: a.unlocked_at || a.created_at,
        });
      });

      // Tournament finishes
      (tourneyRes.data || []).forEach((t: any) => {
        if (t.finish_position <= 3) {
          items.push({
            id: `tourney-${t.id}`,
            userId: t.user_id,
            username: t.profiles?.username || 'Unknown',
            avatarUrl: t.profiles?.avatar_url,
            type: 'tournament_finish',
            title: `${t.profiles?.username} finished #${t.finish_position}!`,
            description: t.tournaments?.name || 'Tournament',
            createdAt: t.updated_at || t.created_at,
          });
        }
      });

      // Kudos received
      (kudosRes.data || []).forEach((k: any) => {
        items.push({
          id: `kudos-${k.id}`,
          userId: k.to_user_id,
          username: k.to_profile?.username || 'Unknown',
          avatarUrl: k.to_profile?.avatar_url,
          type: 'kudos_received',
          title: `${k.to_profile?.username} received kudos!`,
          description: `${k.from_profile?.username} gave "${k.type.replace('_', ' ')}"`,
          createdAt: k.created_at,
        });
      });

      // Sort by date and limit
      return {
        data: items
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, limit),
      };
    } catch (err) {
      console.error('[Social] getEnrichedSocialFeed unexpected error:', err);
      return { data: [], error: 'Unexpected error loading social feed' };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CLUB MEMBER ONLINE COUNT
  // ═══════════════════════════════════════════════════════════════════════════

  /** Get count of online members for a club via Supabase Presence */
  async getClubOnlineCount(clubId: string): Promise<number> {
    const channelKey = `club-presence-${clubId}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    const state = channel.presenceState();
    let count = 0;
    Object.values(state).forEach((presences) => {
      count += (presences as any[]).length;
    });
    return count;
  }

  /** Subscribe to club presence for live online count */
  subscribeToClubPresence(
    clubId: string,
    userId: string,
    callback: (count: number) => void
  ): () => void {
    const channelKey = `club-presence-${clubId}`;
    const channel = masterBus.getOrCreateChannel(channelKey);

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      let count = 0;
      Object.values(state).forEach((presences) => {
        count += (presences as any[]).length;
      });
      callback(count);
    });

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ user_id: userId, online_at: new Date().toISOString() });
      }
    });

    return () => {
      // Untrack presence before removing channel to avoid stale presence entries
      try { channel.untrack(); } catch { /* already untracked */ }
      masterBus.removeRegisteredChannel(channelKey);
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // JOIN REQUEST STATUS TRACKING
  // ═══════════════════════════════════════════════════════════════════════════

  /** Get user's pending join requests */
  async getMyJoinRequests(userId: string): Promise<JoinRequest[]> {
    try {
      const { data, error } = await supabase
        .from('club_join_requests')
        .select('*, clubs:club_id(name)')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) console.warn('[Social] getMyJoinRequests error:', error.message);

      return (data || []).map((r: any) => ({
        id: r.id,
        clubId: r.club_id,
        clubName: r.clubs?.name || 'Unknown Club',
        userId: r.user_id,
        status: r.status,
        createdAt: r.created_at,
      }));
    } catch (err) {
      console.warn('[Social] getMyJoinRequests unexpected error:', err);
      return [];
    }
  }

  /** Check if user has a pending request for a specific club */
  async hasJoinRequest(
    userId: string,
    clubId: string
  ): Promise<'pending' | 'approved' | 'rejected' | null> {
    try {
      const { data, error } = await supabase
        .from('club_join_requests')
        .select('status')
        .eq('user_id', userId)
        .eq('club_id', clubId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) console.warn('[Social] hasJoinRequest error:', error.message);
      return data?.status || null;
    } catch (err) {
      console.warn('[Social] hasJoinRequest unexpected error:', err);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FRIEND ONLINE COUNT (for Tab Bar badge)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Get real-time count of online friends (via presence state) */
  getOnlineFriendsFromPresence(friendIds: string[]): number {
    const channelKey = 'global-presence';
    try {
      const channel = masterBus.getOrCreateChannel(channelKey);
      const state = channel.presenceState();
      const onlineIds = new Set<string>();
      Object.values(state).forEach((presences) => {
        (presences as any[]).forEach((p) => onlineIds.add(p.user_id));
      });
      return friendIds.filter((id) => onlineIds.has(id)).length;
    } catch (err) {
      console.error('[SocialEnhancementsService] Error:', err);
      return 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RICH PUSH NOTIFICATIONS WITH AVATAR
  // ═══════════════════════════════════════════════════════════════════════════

  /** Enhanced browser notification with avatar */
  async sendRichNotification(
    title: string,
    body: string,
    senderUserId?: string,
    url?: string
  ): Promise<void> {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    let icon = '/favicon.ico';
    if (senderUserId) {
      const { data } = await supabase
        .from('profiles')
        .select('avatar_url')
        .eq('id', senderUserId)
        .maybeSingle();
      if (data?.avatar_url) icon = data.avatar_url;
    }

    const notification = new Notification(title, {
      body,
      icon,
      badge: '/favicon.ico',
      tag: `notif-${Date.now()}`,
    });

    if (url) {
      notification.onclick = () => {
        window.focus();
        const isInIframe = typeof window !== 'undefined' && window.parent !== window;
        if (isInIframe) {
          window.parent.postMessage({ type: 'NAVIGATE', path: url }, '*');
        }
        // Non-iframe: handled by React Router outside this service
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLAYER GRAPH VISUALIZATION DATA
  // ═══════════════════════════════════════════════════════════════════════════

  /** Get player connection graph data for visualization */
  async getPlayerGraph(userId: string): Promise<{
    nodes: Array<{ id: string; label: string; avatar?: string; isCenter: boolean }>;
    edges: Array<{ from: string; to: string; strength: number }>;
  }> {
    try {
      // Get all friends + own profile in parallel
      const [friendRes, profileRes] = await Promise.all([
        supabase
          .from('friendships')
          .select(
            'user_id, friend_id, profiles_user:user_id(username, avatar_url), profiles_friend:friend_id(username, avatar_url)'
          )
          .or(`user_id.eq.${userId},friend_id.eq.${userId}`)
          .eq('status', 'accepted')
          .limit(50),
        supabase.from('profiles').select('username, avatar_url').eq('id', userId).maybeSingle(),
      ]);

      if (friendRes.error)
        console.warn('[Social] getPlayerGraph friends error:', friendRes.error.message);
      if (profileRes.error)
        console.warn('[Social] getPlayerGraph profile error:', profileRes.error.message);

      const nodes: Array<{ id: string; label: string; avatar?: string; isCenter: boolean }> = [];
      const edges: Array<{ from: string; to: string; strength: number }> = [];
      const nodeSet = new Set<string>();

      // Add center node (current user)
      nodes.push({
        id: userId,
        label: profileRes.data?.username || 'You',
        avatar: profileRes.data?.avatar_url,
        isCenter: true,
      });
      nodeSet.add(userId);

      // Add friend nodes + edges
      (friendRes.data || []).forEach((f: any) => {
        const friendId = f.user_id === userId ? f.friend_id : f.user_id;
        const friendProfile = f.user_id === userId ? f.profiles_friend : f.profiles_user;

        if (!nodeSet.has(friendId)) {
          nodes.push({
            id: friendId,
            label: friendProfile?.username || 'Unknown',
            avatar: friendProfile?.avatar_url,
            isCenter: false,
          });
          nodeSet.add(friendId);
        }

        edges.push({ from: userId, to: friendId, strength: 1 });
      });

      return { nodes, edges };
    } catch (err) {
      console.warn('[Social] getPlayerGraph unexpected error:', err);
      return { nodes: [], edges: [] };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RICH TEXT / MARKDOWN RENDERING UTILITY
  // ═══════════════════════════════════════════════════════════════════════════

  /** Parse basic markdown-like syntax in messages (XSS-safe) */
  renderRichText(text: string): string {
    // SECURITY: Escape HTML entities FIRST to prevent XSS
    let rendered = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

    // Bold: **text**
    rendered = rendered.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic: *text* or _text_
    rendered = rendered.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    rendered = rendered.replace(/_(.+?)_/g, '<em>$1</em>');
    // Code: `text`
    rendered = rendered.replace(
      /`(.+?)`/g,
      '<code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:4px;font-family:monospace;font-size:0.85em">$1</code>'
    );
    // Strikethrough: ~~text~~
    rendered = rendered.replace(/~~(.+?)~~/g, '<del>$1</del>');
    // Links: auto-detect URLs
    rendered = rendered.replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:#00d4ff;text-decoration:underline">$1</a>'
    );
    return rendered;
  }
}

export const socialEnhancementsService = new SocialEnhancementsServiceClass();
