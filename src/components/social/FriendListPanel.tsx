/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FRIEND LIST PANEL — Social Friends Component
 * Displays friend list with online status and quick actions
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef, memo } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { useAuthUser } from '../../hooks/useAuthUser';
import { PlayerAvatar } from '../avatars/PlayerAvatar';
import { haptic } from '../../services/HapticService';
import type { VipTier, PresenceStatus } from '../avatars/PlayerAvatar';
import styles from './FriendListPanel.module.css';
import { reportError } from '../../utils/errorReporter';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../../utils/playerDisplayName';

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
  useMasterBusSubscription('FRIEND_REQUEST_ACCEPTED', () => {
    loadFriendsRef.current();
  });

  useMasterBusSubscription('FRIEND_REQUEST_SENT', () => {
    loadFriendsRef.current();
  });

  useMasterBusSubscription('TABLE_SEATED', () => {
    loadFriendsRef.current(); // Refresh to pick up "playing" status
  });

  useMasterBusSubscription('TABLE_LEFT', () => {
    loadFriendsRef.current();
  });

  const loadFriends = async () => {
    if (!user?.id) return;
    setLoading(true);

    try {
      // Get friends list — BIDIRECTIONAL: user may be user_id OR friend_id
      // Query 1: friendships where I am user_id (I sent the request)
      const { data: outbound, error: outErr } = await supabase
        .from('friendships')
        .select('id, friend_id')
        .eq('user_id', user.id)
        .eq('status', 'accepted');

      // Query 2: friendships where I am friend_id (they sent the request)
      const { data: inbound, error: inErr } = await supabase
        .from('friendships')
        .select('id, user_id')
        .eq('friend_id', user.id)
        .eq('status', 'accepted');

      if (outErr) throw outErr;
      if (inErr) throw inErr;

      // Batch-fetch all friend profiles (no FK hints needed)
      const outboundIds = (outbound || []).map((f: any) => f.friend_id);
      const inboundIds = (inbound || []).map((f: any) => f.user_id);
      const allFriendIds = [...new Set([...outboundIds, ...inboundIds])];
      const profileMap: Record<string, any> = {};
      if (allFriendIds.length > 0) {
        try {
          const { data: profiles } = await supabase
            .from('profiles')
            .select(`id, ${PLAYER_NAME_COLUMNS}, avatar_url, level, tier`)
            .in('id', allFriendIds);
          if (profiles) {
            for (const p of profiles) profileMap[p.id] = p;
          }
        } catch (e) {
          reportError(e, 'FriendListPanel.inboundIds');
          /* non-critical */
        }
      }

      // Map outbound friends (friend_id is the other person)
      const outboundFriends: Friend[] = (outbound || []).map((f: any) => {
        const p = profileMap[f.friend_id];
        return {
          id: f.id,
          friendId: f.friend_id,
          displayName: playerDisplayName(p),
          username: p?.username || '',
          avatarUrl: p?.avatar_url,
          isOnline: false,
          status: 'offline' as PresenceStatus,
          tableName: undefined,
          level: p?.level || 1,
          vipTier: (p?.tier as VipTier) || 'bronze',
        };
      });

      // Map inbound friends (user_id is the other person)
      const inboundFriends: Friend[] = (inbound || []).map((f: any) => {
        const p = profileMap[f.user_id];
        return {
          id: f.id,
          friendId: f.user_id,
          displayName: playerDisplayName(p),
          username: p?.username || '',
          avatarUrl: p?.avatar_url,
          isOnline: false,
          status: 'offline' as PresenceStatus,
          tableName: undefined,
          level: p?.level || 1,
          vipTier: (p?.tier as VipTier) || 'bronze',
        };
      });

      // Merge and deduplicate by friendId
      const seen = new Set<string>();
      const friendList: Friend[] = [];
      for (const f of [...outboundFriends, ...inboundFriends]) {
        if (!seen.has(f.friendId)) {
          seen.add(f.friendId);
          friendList.push(f);
        }
      }

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
      reportError(err, 'FriendListPanel.Failed_to_load_friends');
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
      const { data: existing, error: existingErr } = await supabase
        .from('friendships')
        .select('id')
        .eq('user_id', user.id)
        .eq('friend_id', targetUser.id)
        .maybeSingle();

      if (!isMounted.current) return;

      /* A FAILED CHECK IS NOT "NOT FRIENDS YET" (2026-08-29). Only `data` was
         destructured, and a Supabase builder resolves with {data: null, error}
         rather than rejecting -- so any failure of this lookup read as "no
         friendship" and fell through to the insert below. The unique
         constraint refuses the duplicate, so what the player actually saw was
         a raw database error where "Already friends" was the truth. */
      if (existingErr) {
        reportError(existingErr, 'FriendListPanel.friendship_check');
        setError('Could not check that friendship. Try again.');
        setAddingFriend(false);
        return;
      }

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
        message: `${playerDisplayName(user)} wants to be your friend!`,
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
    if (!user?.id) return;
    // SECURITY: Only allow deleting friendships the current user is part of
    const { error } = await supabase
      .from('friendships')
      .delete()
      .eq('id', friendshipId)
      .or(`user_id.eq.${user.id},friend_id.eq.${user.id}`);
    if (error) {
      reportError(error, 'FriendListPanel.Failed_to_remove_friend');
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
        return '●';
      case 'playing':
        return '♠';
      case 'away':
        return '●';
      default:
        return '●';
    }
  };

  return (
    <div className={styles.panel}>
      {/* Header */}
      <div className={styles.header}>
        <h3> Friends</h3>
        <span className={styles.onlineCount}>{onlineCount} Online</span>
      </div>

      {/* Search */}
      <div className={styles.searchBar}>
        <input
          type="text"
          placeholder="Search Friends..."
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
            placeholder="Enter Username..."
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
            {searchQuery ? 'No Friends Match Your Search' : 'No Friends Yet'}
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
                presenceStatus={friend.status}
                isPlaying={friend.status === 'playing'}
                showPresence={true}
                showLevelBadge={true}
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
                    title="Invite To Table"
                    aria-label="Invite To Table"
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
