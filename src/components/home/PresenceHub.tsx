import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import haptic from '../../services/HapticService';
import { useAuthUser } from '../../hooks/useAuthUser';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import './PresenceHub.css';

interface OnlineFriend {
  id: string;
  username: string;
  avatar?: string;
  status: 'playing' | 'online';
  table?: string;
}

export default function PresenceHub() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const [onlineFriends, setOnlineFriends] = useState<OnlineFriend[]>([]);

  /**
   * Fetch real online friends from friendships + profiles tables.
   * Uses bidirectional friendship query (user_id ↔ friend_id).
   */
  const fetchOnlineFriends = useCallback(async () => {
    if (!user?.id) return;

    try {
      // Step 1: Get all accepted friend IDs (bidirectional)
      const [{ data: dir1 }, { data: dir2 }] = await Promise.all([
        supabase
          .from('friendships')
          .select('friend_id')
          .eq('user_id', user.id)
          .eq('status', 'accepted'),
        supabase
          .from('friendships')
          .select('user_id')
          .eq('friend_id', user.id)
          .eq('status', 'accepted'),
      ]);

      const friendIds = new Set<string>();
      (dir1 || []).forEach((f: any) => f.friend_id && friendIds.add(f.friend_id));
      (dir2 || []).forEach((f: any) => f.user_id && friendIds.add(f.user_id));

      if (friendIds.size === 0) {
        setOnlineFriends([]);
        return;
      }

      // Step 2: Get profiles of online friends
      const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, is_online')
        .in('id', Array.from(friendIds))
        .eq('is_online', true)
        .limit(20);

      if (error) {
        console.error('[PresenceHub] Error fetching online friends:', error);
        return;
      }

      const friends: OnlineFriend[] = (profiles || []).map((p: any) => ({
        id: p.id,
        username: p.display_name || p.username || 'Player',
        avatar: p.avatar_url || undefined,
        status: 'online' as const,
        table: undefined,
      }));

      // Sort: playing friends first, then online
      friends.sort((a, b) => (a.status === 'playing' ? -1 : 1) - (b.status === 'playing' ? -1 : 1));
      setOnlineFriends(friends);
    } catch (err) {
      console.error('[PresenceHub] Unexpected error:', err);
    }
  }, [user?.id]);

  // Initial fetch + periodic refresh every 30s
  useEffect(() => {
    fetchOnlineFriends();
    const interval = setInterval(fetchOnlineFriends, 30000);
    return () => clearInterval(interval);
  }, [fetchOnlineFriends]);

  // Live-sync: refresh when friend events fire
  useEffect(() => {
    const unsub1 = masterBus.subscribeDebounced('FRIEND_REQUEST_ACCEPTED', fetchOnlineFriends, 500);
    const unsub2 = masterBus.subscribeDebounced('PROFILE_UPDATED', fetchOnlineFriends, 1000);
    return () => {
      unsub1();
      unsub2();
    };
  }, [fetchOnlineFriends]);

  // Supabase Realtime: listen for profile online status changes from friends
  useEffect(() => {
    if (!user?.id) return;

    const channel = supabase
      .channel(`presence-hub-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles',
          filter: 'is_online=eq.true',
        },
        () => {
          // Debounce by using a short timeout to batch rapid changes
          fetchOnlineFriends();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id, fetchOnlineFriends]);

  if (onlineFriends.length === 0) return null;

  const playingCount = onlineFriends.filter((f) => f.status === 'playing').length;

  return (
    <div className="presence-hub">
      <div className="presence-header" onClick={() => navigate('/friends')}>
        <div className="presence-title">
          <span className="live-dot-pulse"></span>
          <h3>Who's Online</h3>
        </div>
        <span className="presence-subtitle">{playingCount} playing right now</span>
      </div>
      <div className="presence-avatars">
        {onlineFriends.slice(0, 5).map((friend) => (
          <div
            key={friend.id}
            className={`presence-avatar-wrapper ${friend.status === 'playing' ? 'is-playing' : ''}`}
            title={`${friend.username} - ${friend.status === 'playing' ? 'Playing at ' + friend.table : 'Online'}`}
            onClick={() => {
              haptic.light();
              navigate(`/profile/${friend.id}`);
            }}
          >
            {friend.avatar ? (
              <img loading="lazy" decoding="async" src={friend.avatar} alt={friend.username} />
            ) : (
              <div className="presence-avatar-fallback">{friend.username[0]?.toUpperCase()}</div>
            )}
            <div className={`status-badge ${friend.status}`} />
          </div>
        ))}
        {onlineFriends.length > 5 && (
          <div
            className="presence-more"
            onClick={() => {
              haptic.light();
              navigate('/friends');
            }}
          >
            +{onlineFriends.length - 5}
          </div>
        )}
      </div>
    </div>
  );
}
