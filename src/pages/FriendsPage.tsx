/**
 * 👫 FRIENDS PAGE — Friends List & Management with Real-Time Status
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { masterBus } from '../core/MasterBus';
import { useToast } from '../components/common/Toast';
import { retryFetch } from '../utils/retryFetch';
import { useIsMounted } from '../hooks/useIsMounted';
import { exportToCSV } from '../lib/export';
import FriendsList from '../components/social/FriendsList';
import RecentPlayers from '../components/social/RecentPlayers';
import FriendActivityFeed from '../components/social/FriendActivityFeed';
import InviteToTable from '../components/social/InviteToTable';
import FriendChallengeModal from '../components/social/FriendChallengeModal';
import FriendSuggestions from '../components/social/FriendSuggestions';
import { useSwipeAction } from '../hooks/useSwipeAction';
import { playerStatusService } from '../services/PlayerStatusService';
import './FriendsPage.css';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import PageSkeleton from '../components/common/PageSkeleton';

interface Friend {
  id: string;
  user_id: string;
  username: string;
  avatar_url?: string;
  is_online: boolean;
}

type FriendsTab = 'friends' | 'pending' | 'recent';

// ── SWR Cache helpers (with 5-minute TTL) ──
const FR_CACHE_PREFIX = 'fr_cache_';
const FR_CACHE_TS_PREFIX = 'fr_cache_ts_';
const FR_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedFriends(userId: string) {
  try {
    const tsRaw = sessionStorage.getItem(FR_CACHE_TS_PREFIX + userId);
    if (tsRaw) {
      const ts = parseInt(tsRaw, 10);
      if (Date.now() - ts > FR_CACHE_TTL) {
        // Cache expired — clear it
        sessionStorage.removeItem(FR_CACHE_PREFIX + userId);
        sessionStorage.removeItem(FR_CACHE_TS_PREFIX + userId);
        return null;
      }
    }
    const raw = sessionStorage.getItem(FR_CACHE_PREFIX + userId);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function setCachedFriends(userId: string, data: any) {
  try {
    sessionStorage.setItem(FR_CACHE_PREFIX + userId, JSON.stringify(data));
    sessionStorage.setItem(FR_CACHE_TS_PREFIX + userId, String(Date.now()));
  } catch {
    /* quota */
  }
}

export default function FriendsPage() {
  const navigate = useNavigate();
  useVisibilityRefresh(() => loadFriends());
  const { user } = useAuthUser();
  const toast = useToast();
  const isMounted = useIsMounted();

  const [friends, setFriends] = useState<Friend[]>([]);
  const [pendingRequests, setPendingRequests] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<FriendsTab>('friends');
  const [searchQuery, setSearchQuery] = useState('');
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [visibleFriendRows, setVisibleFriendRows] = useState(new Set<number>());
  const [visiblePendingRows, setVisiblePendingRows] = useState(new Set<number>());
  const [searchFocused, setSearchFocused] = useState(false);
  const [challengeTarget, setChallengeTarget] = useState<{ id: string; name: string } | null>(null);
  const loadFriendsRef = useRef(async () => {});
  const hasDataRef = useRef(false);

  // SWR: show cached friends list instantly on mount
  useEffect(() => {
    if (!user?.id) return;
    const cached = getCachedFriends(user.id);
    if (cached && cached.length > 0) {
      setFriends(cached);
      hasDataRef.current = true;
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    if (user?.id) loadFriends();
  }, [user?.id]);

  // Keep ref pointing to the latest version of loadFriends to avoid stale closures
  useEffect(() => {
    loadFriendsRef.current = loadFriends;
  });

  // Real-time presence tracking for friends
  useEffect(() => {
    if (!user?.id) return;

    const presenceKey = 'global-presence'; // Shared global channel so users actually intersect
    const channel = masterBus.getOrCreateChannel(presenceKey);

    // Track online status
    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        const onlineIds = new Set<string>();
        Object.values(state).forEach((presences) => {
          (presences as any[]).forEach((p) => onlineIds.add(p.user_id));
        });
        setOnlineUserIds(onlineIds);
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ user_id: user.id, online_at: new Date().toISOString() });
        }
      });

    return () => {
      masterBus.removeRegisteredChannel(presenceKey);
    };
  }, [user?.id]);

  // Real-time friend request notifications
  useEffect(() => {
    let isMounted = true;
    if (!user?.id) return;

    const channelKey = `friend-requests-${user.id}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'friendships',
          filter: `friend_id=eq.${user.id}`,
        },
        (payload) => {
          if (!isMounted) return;
          // New friend request!
          if (loadFriendsRef.current) loadFriendsRef.current();
          toast.success('New friend request received!');
        }
      )
      .subscribe();

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [user?.id]);

  // ── Bus Listeners: cross-page friend reactivity (debounced) ──
  useEffect(() => {
    let isMounted = true;
    const handler = () => {
      if (isMounted && loadFriendsRef.current) {
        setIsRefreshing(true);
        loadFriendsRef.current().finally(() => {
          if (isMounted) setIsRefreshing(false);
        });
      }
    };
    const unsubs = [
      masterBus.subscribeDebounced('FRIEND_REQUEST_ACCEPTED', handler, 500),
      masterBus.subscribeDebounced('FRIEND_REQUEST_SENT', handler, 500),
      masterBus.subscribeDebounced('PROFILE_UPDATED', handler, 500),
      // Q3: Reactively update when a user is blocked/unblocked
      masterBus.subscribeDebounced('USER_BLOCKED', handler, 500),
      masterBus.subscribeDebounced('USER_UNBLOCKED', handler, 500),
    ];
    return () => {
      isMounted = false;
      unsubs.forEach((u) => u());
    };
  }, []);

  const loadingRef = useRef(false);

  const loadFriends = async (getIsMounted?: () => boolean) => {
    if (!user?.id) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (!hasDataRef.current) setLoading(true);
    try {
      // ── Batch: sent + received friendships + pending requests in parallel ──
      const [sentResult, receivedResult, pendingResult] = await Promise.all([
        retryFetch(
          () =>
            supabase
              .from('friendships')
              .select('id, friend_id, status')
              .eq('user_id', user?.id)
              .eq('status', 'accepted')
              .order('created_at', { ascending: false })
              .limit(200)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        ),
        retryFetch(
          () =>
            supabase
              .from('friendships')
              .select('id, user_id, status')
              .eq('friend_id', user?.id)
              .eq('status', 'accepted')
              .order('created_at', { ascending: false })
              .limit(200)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        ),
        retryFetch(
          () =>
            supabase
              .from('friendships')
              .select('id, user_id')
              .eq('friend_id', user?.id)
              .eq('status', 'pending')
              .order('created_at', { ascending: false })
              .limit(100)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        ),
      ]);

      // Collect all friend user IDs for batch profile lookup
      const sentFriendIds = (sentResult.data || []).map((f: any) => f.friend_id);
      const receivedFriendIds = (receivedResult.data || []).map((f: any) => f.user_id);
      const pendingUserIds = (pendingResult.data || []).map((p: any) => p.user_id);
      const allProfileIds = [
        ...new Set([...sentFriendIds, ...receivedFriendIds, ...pendingUserIds]),
      ];

      // Batch-fetch all profiles at once (no FK hints needed)
      const profileMap: Record<string, { username?: string; avatar_url?: string }> = {};
      if (allProfileIds.length > 0) {
        try {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, username, avatar_url')
            .in('id', allProfileIds);
          if (profiles) {
            for (const p of profiles)
              profileMap[p.id] = { username: p.username, avatar_url: p.avatar_url };
          }
        } catch {
          /* non-critical */
        }
      }

      // Map sent friendships (friend_id is the other person)
      const sentMapped = (sentResult.data || []).map((f: any) => ({
        ...f,
        friend: {
          id: f.friend_id,
          username: profileMap[f.friend_id]?.username,
          avatar_url: profileMap[f.friend_id]?.avatar_url,
        },
      }));
      // Map received friendships (user_id is the other person)
      const receivedMapped = (receivedResult.data || []).map((f: any) => ({
        ...f,
        friend: {
          id: f.user_id,
          username: profileMap[f.user_id]?.username,
          avatar_url: profileMap[f.user_id]?.avatar_url,
        },
      }));

      const allFriendships = [...sentMapped, ...receivedMapped];

      if (getIsMounted && !getIsMounted()) return;
      if (!isMounted.current) return;

      if (allFriendships.length > 0) {
        const uniqueMap = new Map();
        allFriendships.forEach((f: any) => {
          if (f.friend?.id && !uniqueMap.has(f.friend.id)) {
            uniqueMap.set(f.friend.id, {
              id: f.id,
              user_id: f.friend.id,
              username: f.friend.username || 'Unknown',
              avatar_url: f.friend.avatar_url,
              is_online: onlineUserIds.has(f.friend.id),
            });
          }
        });

        // NOTE: status_text column does not exist in profiles table yet (future feature).
        // Skipping status enrichment until the column is added.

        setFriends(Array.from(uniqueMap.values()));
        // Update SWR cache
        if (isMounted.current) setCachedFriends(user?.id || '', Array.from(uniqueMap.values()));
        hasDataRef.current = true;
      } else {
        setFriends([]);
      }

      // Use pending results from the parallel batch
      const pending = pendingResult.data;

      if (getIsMounted && !getIsMounted()) return;

      if (pending) {
        setPendingRequests(
          pending.map((p: any) => ({
            id: p.id,
            user_id: p.user_id,
            username: profileMap[p.user_id]?.username || 'Unknown',
            avatar_url: profileMap[p.user_id]?.avatar_url,
            is_online: onlineUserIds.has(p.user_id),
          }))
        );
      }
    } catch (error) {
      console.error('Failed to load friends:', error);
      toast.error('Failed to load friends');
    } finally {
      loadingRef.current = false;
      if (!getIsMounted || getIsMounted()) {
        if (isMounted.current) setLoading(false);
      }
    }
  };

  const acceptRequest = async (friendshipId: string) => {
    try {
      const { error } = await supabase
        .from('friendships')
        .update({ status: 'accepted' })
        .eq('id', friendshipId)
        .eq('friend_id', user?.id); // Only recipient can accept
      if (error) throw error;
      masterBus.emit('FRIEND_REQUEST_ACCEPTED', { friendshipId });
      loadFriends();
      toast.success('Friend request accepted!');
    } catch (err) {
      console.error('[Friends] Failed to accept request:', err);
      toast.error('Failed to accept request');
    }
  };

  const declineRequest = async (friendshipId: string) => {
    try {
      const { error } = await supabase
        .from('friendships')
        .delete()
        .eq('id', friendshipId)
        .eq('friend_id', user?.id); // Only recipient can decline
      if (error) throw error;
      loadFriends();
      toast.success('Friend request declined');
    } catch (err) {
      console.error('[Friends] Failed to decline request:', err);
      toast.error('Failed to decline request');
    }
  };

  const removeFriend = async (friendshipId: string) => {
    try {
      const { error } = await supabase
        .from('friendships')
        .delete()
        .eq('id', friendshipId)
        .or(`user_id.eq.${user?.id},friend_id.eq.${user?.id}`); // Either user can remove
      if (error) throw error;
      loadFriends();
      toast.success('Friend removed');
    } catch (err) {
      console.error('[Friends] Failed to remove friend:', err);
      toast.error('Failed to remove friend');
    }
  };

  const sendFriendRequest = async (playerId: string) => {
    if (!user?.id) return;
    try {
      const { error } = await supabase.from('friendships').insert({
        user_id: user.id,
        friend_id: playerId,
        status: 'pending',
      });
      if (error) {
        if (error.code === '23505') {
          toast.info('Friend request already sent');
          return;
        }
        throw error;
      }
      masterBus.emit('FRIEND_REQUEST_SENT', { toUserId: playerId });
      toast.success('Friend request sent!');
    } catch (err) {
      console.error('[Friends] Failed to send request:', err);
      toast.error('Failed to send friend request');
    }
  };

  // Update friend online status when presence changes
  const friendsWithStatus = friends.map((f) => ({
    ...f,
    is_online: onlineUserIds.has(f.user_id),
  }));

  const filteredFriends = friendsWithStatus.filter((f) =>
    (f.username || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Stagger friend rows on render
  useEffect(() => {
    const timers = filteredFriends.map((_, i) =>
      setTimeout(() => setVisibleFriendRows((prev) => new Set([...prev, i])), i * 50)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [filteredFriends.length]);

  // Stagger pending rows
  useEffect(() => {
    const timers = pendingRequests.map((_, i) =>
      setTimeout(() => setVisiblePendingRows((prev) => new Set([...prev, i])), i * 50)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [pendingRequests.length]);

  const onlineCount = friendsWithStatus.filter((f) => f.is_online).length;

  return (
    <div className="friends-page">
      <div className="friends-summary">
        <div className="summary-stat">
          <span className="stat-value">{friends.length}</span>
          <span className="stat-label">Friends</span>
        </div>
        <div className="summary-stat online">
          <span className="stat-value">{onlineCount}</span>
          <span className="stat-label">Online</span>
        </div>
        {pendingRequests.length > 0 && (
          <div className="summary-stat pending">
            <span className="stat-value">{pendingRequests.length}</span>
            <span className="stat-label">Pending</span>
          </div>
        )}
      </div>

      {/* Q3: Friend Suggestions - "People You May Know" */}
      <FriendSuggestions />

      <div className="friends-tabs fr-chip-bar">
        <button
          className={`fr-filter-chip ${activeTab === 'friends' ? 'active' : ''}`}
          onClick={() => setActiveTab('friends')}
        >
          👥 Friends ({friends.length})
        </button>
        <button
          className={`fr-filter-chip ${activeTab === 'pending' ? 'active' : ''}`}
          onClick={() => setActiveTab('pending')}
        >
          🔔 Requests{' '}
          {pendingRequests.length > 0 && (
            <span className="fr-pending-badge">{pendingRequests.length}</span>
          )}
        </button>
        <button
          className={`fr-filter-chip ${activeTab === 'recent' ? 'active' : ''}`}
          onClick={() => setActiveTab('recent')}
        >
          🕒 Recent
        </button>
      </div>

      {activeTab === 'friends' && (
        <>
          <div className="friends-search">
            <input
              type="text"
              placeholder="Search friends..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              style={{
                boxShadow: searchFocused ? '0 0 16px rgba(0, 212, 255, 0.4)' : 'none',
                transition: 'box-shadow 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            />
            {filteredFriends.length > 0 && (
              <button
                style={{
                  background: 'rgba(65,105,225,0.15)',
                  color: '#4169E1',
                  border: '1px solid rgba(65,105,225,0.3)',
                  padding: '6px 14px',
                  borderRadius: '8px',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
                onClick={() => {
                  try {
                    exportToCSV(filteredFriends, 'friends_list.csv', [
                      { key: 'username', label: 'Username' },
                      { key: 'is_online', label: 'Online' },
                      { key: 'user_id', label: 'User ID' },
                    ]);
                    toast.success('Friends exported!');
                  } catch {
                    toast.error('Export failed');
                  }
                }}
              >
                📥 Export
              </button>
            )}
          </div>

          <div className="friends-list">
            {loading ? (
              <div className="fr-skeleton-list">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="fr-skeleton-row">
                    <div className="fr-skel-avatar" />
                    <div className="fr-skel-text">
                      <div className="fr-skel-name" />
                      <div className="fr-skel-status" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filteredFriends.length === 0 ? (
              <div className="empty-state">
                <span className="empty-icon">👫</span>
                <p>No friends yet</p>
                <button className="btn btn-primary" onClick={() => navigate('/search?tab=players')}>
                  Find Friends
                </button>
              </div>
            ) : (
              <>
                {filteredFriends.filter((f) => f.is_online).length > 0 && (
                  <div className="friend-group">
                    <h3 className="friend-group-header">
                      Online — {filteredFriends.filter((f) => f.is_online).length}
                    </h3>
                    {filteredFriends
                      .filter((f) => f.is_online)
                      .map((friend, index) => (
                        <SwipeableFriendRow
                          key={friend.id}
                          friend={friend}
                          visible={visibleFriendRows.has(filteredFriends.indexOf(friend))}
                          onMessage={() => navigate(`/messages/new?userId=${friend.user_id}`)}
                          onRemove={() => removeFriend(friend.id)}
                          onChallenge={() =>
                            setChallengeTarget({ id: friend.user_id, name: friend.username })
                          }
                          navigate={navigate}
                        />
                      ))}
                  </div>
                )}
                {filteredFriends.filter((f) => !f.is_online).length > 0 && (
                  <div className="friend-group">
                    <h3 className="friend-group-header">
                      Offline — {filteredFriends.filter((f) => !f.is_online).length}
                    </h3>
                    {filteredFriends
                      .filter((f) => !f.is_online)
                      .map((friend, index) => (
                        <SwipeableFriendRow
                          key={friend.id}
                          friend={friend}
                          visible={visibleFriendRows.has(filteredFriends.indexOf(friend))}
                          onMessage={() => navigate(`/messages/new?userId=${friend.user_id}`)}
                          onRemove={() => removeFriend(friend.id)}
                          onChallenge={() =>
                            setChallengeTarget({ id: friend.user_id, name: friend.username })
                          }
                          navigate={navigate}
                        />
                      ))}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {activeTab === 'pending' && (
        <div className="pending-list">
          {pendingRequests.length === 0 ? (
            <div className="empty-state">
              <p>No pending requests</p>
            </div>
          ) : (
            pendingRequests.map((request, index) => (
              <div
                key={request.id}
                className="request-row"
                style={{
                  opacity: visiblePendingRows.has(index) ? 1 : 0,
                  transform: visiblePendingRows.has(index) ? 'translateY(0)' : 'translateY(8px)',
                  transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                }}
              >
                <div className="request-avatar">
                  {request.avatar_url ? (
                    <img src={request.avatar_url} alt="" loading="lazy" />
                  ) : (
                    <span>{request.username[0]?.toUpperCase()}</span>
                  )}
                </div>
                <div className="request-info">
                  <span className="request-name">{request.username}</span>
                  <span className="request-label">wants to be friends</span>
                </div>
                <div className="request-actions">
                  <button className="accept-btn" onClick={() => acceptRequest(request.id)}>
                    ✓
                  </button>
                  <button className="decline-btn" onClick={() => declineRequest(request.id)}>
                    ✕
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'recent' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          <FriendActivityFeed friends={friends} />
          <RecentPlayers
            onAddFriend={(playerId) => {
              sendFriendRequest(playerId);
            }}
            onInviteToTable={(playerId) => {
              navigate(`/messages/new?userId=${playerId}`);
              toast.info('Opening chat to invite...');
            }}
          />
        </div>
      )}

      {/* Friend Challenge Modal */}
      {user?.id && challengeTarget && (
        <FriendChallengeModal
          isOpen={!!challengeTarget}
          onClose={() => setChallengeTarget(null)}
          challengerId={user.id}
          challengeeId={challengeTarget.id}
          challengeeName={challengeTarget.name}
        />
      )}
    </div>
  );
}

function SwipeableFriendRow({ friend, visible, onMessage, onRemove, onChallenge, navigate }: any) {
  const { handlers, rowStyle, offset, reset } = useSwipeAction({
    actionWidth: 80,
    threshold: 40,
    onSwipeRight: () => {
      // Swipe right reveals left action (Message)
    },
    onSwipeLeft: () => {
      // Swipe left reveals right action (Remove)
    },
  });

  return (
    <div
      className="swipe-container"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(8px)',
        transition: 'opacity 0.3s, transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }}
    >
      <div
        className="swipe-actions-left"
        onClick={(e) => {
          e.stopPropagation();
          reset();
          onMessage();
        }}
      >
        💬
      </div>
      <div
        className="swipe-actions-right"
        onClick={(e) => {
          e.stopPropagation();
          reset();
          onRemove();
        }}
      >
        🗑️
      </div>
      <div
        className="friend-row surface"
        style={rowStyle}
        {...handlers}
        onClick={() => {
          if (offset !== 0) reset();
          else navigate(`/profile/${friend.user_id}`);
        }}
      >
        <div className="friend-avatar">
          {friend.avatar_url ? (
            <img src={friend.avatar_url} alt="" loading="lazy" />
          ) : (
            <span>{friend.username[0]?.toUpperCase()}</span>
          )}
          {friend.is_online && <span className="online-dot pulse-anim" />}
        </div>
        <div className="friend-info">
          <span className="friend-name">{friend.username}</span>
          {friend.is_online && (
            <span className="friend-status" style={{ fontSize: '0.7rem', color: '#10b981' }}>
              Online
            </span>
          )}
        </div>
        <button
          className="fr-challenge-btn"
          onClick={(e) => {
            e.stopPropagation();
            onChallenge?.();
          }}
          title="Challenge"
          style={{
            background: 'rgba(0, 212, 255, 0.1)',
            border: '1px solid rgba(0, 212, 255, 0.2)',
            borderRadius: '8px',
            padding: '4px 8px',
            color: '#00d4ff',
            fontSize: '0.65rem',
            fontWeight: 700,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          Challenge
        </button>
      </div>
    </div>
  );
}
