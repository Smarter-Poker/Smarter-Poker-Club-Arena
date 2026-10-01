/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ONLINE FRIENDS PILL — Shows online friend avatars on HomePage
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { supabase } from '../../lib/supabase';
import { readPresence } from '../../lib/ownProfile';
import './OnlineFriendsPill.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { reportError } from '../../utils/errorReporter';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../../utils/playerDisplayName';

interface OnlineFriend {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

interface OnlineFriendsPillProps {
  userId: string;
  onFriendClick?: (friendId: string) => void;
}

export default function OnlineFriendsPill({ userId, onFriendClick }: OnlineFriendsPillProps) {
  const [friends, setFriends] = useState<OnlineFriend[]>([]);
  const isMounted = useIsMounted();

  useEffect(() => {
    if (!userId) return;
    loadOnlineFriends();
    // Refresh every 60 seconds to keep online status current
    const interval = setInterval(loadOnlineFriends, 60_000);
    return () => clearInterval(interval);
  }, [userId]);

  // Q3: Bus listeners — instant refresh when friends come online or status changes
  useMasterBusSubscription('PROFILE_UPDATED', () => {
    if (isMounted.current) loadOnlineFriends();
  });
  useMasterBusSubscription('FRIEND_REQUEST_ACCEPTED', () => {
    if (isMounted.current) loadOnlineFriends();
  });

  const loadOnlineFriends = async () => {
    try {
      // First get friend IDs
      const { data: friendships } = await supabase
        .from('friendships')
        .select('friend_id, user_id')
        .or(`user_id.eq.${userId},friend_id.eq.${userId}`)
        .eq('status', 'accepted')
        .limit(20);

      if (!friendships || friendships.length === 0) return;

      const friendIds = friendships.map((f) => (f.user_id === userId ? f.friend_id : f.user_id));

      // Get profiles for friends: public columns only. A friend's last-seen
      // time is theirs (ruling 22); who is online now comes from the presence
      // door, which applies the same five-minute heartbeat rule server-side.
      const [{ data: profiles, error: profilesError }, presence] = await Promise.all([
        supabase
          .from('profiles')
          .select(`id, ${PLAYER_NAME_COLUMNS}, avatar_url`)
          .in('id', friendIds),
        readPresence(friendIds),
      ]);

      if (profilesError) throw profilesError;
      if (!profiles) return;

      const online = profiles
        .filter((p) => presence.get(p.id) === true)
        .map((p) => ({
          id: p.id,
          displayName: playerDisplayName(p),
          avatarUrl: p.avatar_url,
        }));

      if (isMounted.current) setFriends(online);
    } catch (err) {
      reportError(err, 'OnlineFriendsPill.error');
    }
  };

  if (friends.length === 0) return null;

  return (
    <div className="ofp-container">
      <span className="ofp-label">Online Friends</span>
      <div className="ofp-avatars">
        {friends.slice(0, 8).map((friend) => (
          <button
            key={friend.id}
            className="ofp-avatar-btn"
            onClick={() => onFriendClick?.(friend.id)}
            title={friend.displayName}
          >
            {friend.avatarUrl ? (
              <img
                loading="lazy"
                decoding="async"
                src={friend.avatarUrl}
                alt={friend.displayName}
                className="ofp-avatar-img"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = generateDefaultAvatar();
                }}
              />
            ) : (
              <span className="ofp-avatar-text">{friend.displayName.charAt(0).toUpperCase()}</span>
            )}
            <span className="ofp-online-dot" />
          </button>
        ))}
        {friends.length > 8 && <span className="ofp-more">+{friends.length - 8}</span>}
      </div>
    </div>
  );
}
