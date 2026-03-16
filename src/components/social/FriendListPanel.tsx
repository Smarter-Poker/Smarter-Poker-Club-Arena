/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FRIEND LIST PANEL — Social Friends Component
 * Displays friend list with online status and quick actions
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef, memo } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useAuthUser } from '../../hooks/useAuthUser';
import { PlayerAvatar } from '../avatars/PlayerAvatar';
import { haptic } from '../../services/HapticService';
import type { VipTier, PresenceStatus } from '../avatars/PlayerAvatar';
import styles from './FriendListPanel.module.css';

interface Friend {
  id: string;
  friendId: string;
  displayName: string;
  username: string;
  avatarUrl?: string;
  isOnline: boolean;
  status?: PresenceStatus;
  tableName?: string;
  level?: number;
  vipTier?: VipTier;
  xpProgress?: number;
}

interface FriendListPanelProps {
  onMessageClick?: (friendId: string, friendName: string) => void;
  onProfileClick?: (friendId: string) => void;
  onInviteClick?: (friendId: string) => void;
}

function FriendListPanelInner({
  onMessageClick,
  onProfileClick,
  onInviteClick,
}: FriendListPanelProps) {
  const { user } = useAuthUser();
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [addFriendInput, setAddFriendInput] = useState('');
  const [addingFriend, setAddingFriend] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleFriends, setVisibleFriends] = useState<Set<number>>(new Set());
  const loadFriendsRef = useRef<() => void>(() => {});
  const animTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const isMounted = useIsMounted();

  useEffect(() => {
    return () => {
      animTimers.current.forEach(clearTimeout);
      animTimers.current = [];
    };
  }, []);

  useEffect(() => {
    if (user?.id) {
      loadFriends();
    }
  }, [user?.id]);

  // Keep loadFriendsRef pointing to the latest loadFriends
  useEffect(() => {
    loadFriendsRef.current = loadFriends;
  });

  // ── Bus Listeners: cross-page friend list reactivity ──
  useEffect(() => {
    const unsubAccepted = masterBus.subscribe('FRIEND_REQUEST_ACCEPTED', () => {
      loadFriendsRef.current();
    });
    const unsubSent = masterBus.subscribe('FRIEND_REQUEST_SENT', () => {
      loadFriendsRef.current();
    });
    const unsubSeated = masterBus.subscribe('TABLE_SEATED', () => {
      loadFriendsRef.current(); // Refresh to pick up "playing" status
    });
    const unsubLeft = masterBus.subscribe('TABLE_LEFT', () => {
      loadFriendsRef.current();
    });
    return () => {
      unsubAccepted();
      unsubSent();
      unsubSeated();
      unsubLeft();
    };
  }, []);

  const loadFriends = async () => {
    if (!user?.id) return;
    setLoading(true);

    try {
      // Get friends list
      const { data, error } = await supabase
        .from('friendships')
        .select(
          `
                    id,
                    friend_id,
                    profiles!friendships_friend_id_fkey(
                        id, username, display_name, avatar_url, level, tier, xp
                    )
                `
        )
        .eq('user_id', user.id)
        .eq('status', 'accepted');

      if (error) throw error;

      // Map friends (online status would come from real-time subscriptions)
      const friendList: Friend[] = (data || []).map((f: any) => ({
        id: f.id,
        friendId: f.friend_id,
        displayName: f.profiles?.display_name || f.profiles?.username || 'Unknown',
        username: f.profiles?.username || '',
        avatarUrl: f.profiles?.avatar_url,
        isOnline: false, // Will be updated by presence subscriptions
        status: 'offline' as PresenceStatus,
        tableName: undefined,
        level: f.profiles?.level || 1,
        vipTier: (f.profiles?.tier as VipTier) || 'bronze',
        xpProgress: Math.min(100, (f.profiles?.xp || 0) % 100),
      }));

      // Sort by online status
      friendList.sort((a, b) => {
        if (a.isOnline && !b.isOnline) return -1;
        if (!a.isOnline && b.isOnline) return 1;
        return a.displayName.localeCompare(b.displayName);
      });

      if (isMounted.current) {
        setFriends(friendList);
        // Stagger entrance — tracked for cleanup
        animTimers.current.forEach(clearTimeout);
        animTimers.current = [];
        setVisibleFriends(new Set());
        friendList.forEach((_, i) => {
          const t = setTimeout(() => setVisibleFriends((prev) => new Set(prev).add(i)), i * 50);
          animTimers.current.push(t);
        });
      }
    } catch (err) {
      console.error('Failed to load friends:', err);
    }
    if (isMounted.current) setLoading(false);
  };

  const handleAddFriend = async () => {
    if (!addFriendInput.trim() || !user?.id) return;
    setAddingFriend(true);
    setError(null);

    try {
      // Find user by username
      const { data: targetUser, error: findError } = await supabase
        .from('profiles')
        .select('id, username, display_name')
        .ilike('username', addFriendInput.trim())
        .maybeSingle();

      if (!isMounted.current) return;

      if (findError || !targetUser) {
        setError('User not found');
        setAddingFriend(false);
        return;
      }

      if (targetUser.id === user.id) {
        setError("You can't add yourself");
        setAddingFriend(false);
        return;
      }

      // Check if already friends
      const { data: existing } = await supabase
        .from('friendships')
        .select('id')
        .eq('user_id', user.id)
        .eq('friend_id', targetUser.id)
        .maybeSingle();

      if (!isMounted.current) return;

      if (existing) {
        setError('Already friends');
        setAddingFriend(false);
        return;
      }

      // Create friendship request
      const { error: friendError } = await supabase.from('friendships').insert({
        user_id: user.id,
        friend_id: targetUser.id,
        status: 'pending',
      });

      if (friendError) throw friendError;

      // Notify target user (non-critical — don't throw)
      const { error: notifyError } = await supabase.from('notifications').insert({
        user_id: targetUser.id,
        type: 'friend_request',
        title: 'Friend Request',
        message: `${user?.display_name || 'Someone'} wants to be your friend!`,
        data: { from_user_id: user.id },
      });
      if (notifyError) console.warn('[Friends] notification insert failed:', notifyError.message);

      if (isMounted.current) {
        setAddFriendInput('');
        setShowAddFriend(false);
        setError(null);
      }
    } catch (err) {
      if (isMounted.current) setError('Failed to send request');
    }
    if (isMounted.current) setAddingFriend(false);
  };

  const handleRemoveFriend = async (friendshipId: string) => {
    const { error } = await supabase.from('friendships').delete().eq('id', friendshipId);
    if (error) {
      console.error('Failed to remove friend:', error);
      return;
    }
    setFriends((prev) => prev.filter((f) => f.id !== friendshipId));
  };

  const filteredFriends = friends.filter(
    (f) =>
      f.displayName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      f.username.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const onlineCount = friends.filter((f) => f.isOnline).length;

  const getStatusIcon = (status?: string): string => {
    switch (status) {
      case 'online':
        return '🟢';
      case 'playing':
        return '♠';
      case 'away':
        return '🟡';
      default:
        return '⚫';
    }
  };

  return (
    <div className={styles.panel}>
      {/* Header */}
      <div className={styles.header}>
        <h3> Friends</h3>
        <span className={styles.onlineCount}>{onlineCount} online</span>
      </div>

      {/* Search */}
      <div className={styles.searchBar}>
        <input
          type="text"
          placeholder="Search friends..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button className={styles.addBtn} onClick={() => setShowAddFriend(!showAddFriend)}>
          +
        </button>
      </div>

      {/* Add Friend */}
      {showAddFriend && (
        <div className={styles.addFriendRow}>
          <input
            type="text"
            placeholder="Enter username..."
            value={addFriendInput}
            onChange={(e) => setAddFriendInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddFriend()}
          />
          <button onClick={handleAddFriend} disabled={addingFriend}>
            {addingFriend ? '...' : 'Add'}
          </button>
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}

      {/* Friend List */}
      <div className={styles.list}>
        {loading ? (
          <div className={styles.loading}>Loading...</div>
        ) : filteredFriends.length === 0 ? (
          <div className={styles.empty}>
            {searchQuery ? 'No friends match your search' : 'No friends yet'}
          </div>
        ) : (
          filteredFriends.map((friend, idx) => (
            <div
              key={friend.id}
              className={styles.friendRow}
              style={{
                opacity: visibleFriends.has(idx) ? 1 : 0,
                transform: visibleFriends.has(idx) ? 'translateX(0)' : 'translateX(-8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <PlayerAvatar
                src={friend.avatarUrl}
                name={friend.displayName}
                size="md"
                vipTier={friend.vipTier}
                level={friend.level}
                xpProgress={friend.xpProgress}
                presenceStatus={friend.status}
                isPlaying={friend.status === 'playing'}
                showPresence={true}
                showLevelBadge={true}
                showXpRing={true}
                showVipRing={true}
                onClick={() => {
                  haptic.selection();
                  onProfileClick?.(friend.friendId);
                }}
              />

              <div className={styles.info}>
                <span className={styles.name}>{friend.displayName}</span>
                {friend.status === 'playing' && friend.tableName && (
                  <span className={styles.playing}>{friend.tableName}</span>
                )}
              </div>

              <div className={styles.actions}>
                <button
                  className={styles.iconBtn}
                  onClick={() => {
                    haptic.light();
                    onMessageClick?.(friend.friendId, friend.displayName);
                  }}
                  title="Message"
                  aria-label="Message"
                ></button>
                {friend.isOnline && onInviteClick && (
                  <button
                    className={styles.iconBtn}
                    onClick={() => {
                      haptic.light();
                      onInviteClick(friend.friendId);
                    }}
                    title="Invite to table"
                    aria-label="Invite to table"
                  ></button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
export default memo(FriendListPanelInner);
