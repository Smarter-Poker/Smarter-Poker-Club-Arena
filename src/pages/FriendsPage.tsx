import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import CommunitySurfaceHeader from '../components/community/CommunitySurfaceHeader';
import ConfirmModal from '../components/common/ConfirmModal';
import { useToast } from '../components/common/Toast';
import FriendActivityFeed from '../components/social/FriendActivityFeed';
import FriendChallengeModal from '../components/social/FriendChallengeModal';
import FriendChallengesPanel from '../components/social/FriendChallengesPanel';
import FriendSuggestions from '../components/social/FriendSuggestions';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useIsMounted } from '../hooks/useIsMounted';
import { useMasterBusChannel } from '../hooks/useMasterBusChannel';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { exportToCSV } from '../lib/export';
import { supabase } from '../lib/supabase';
import { generateAvatarSvg, sizedStorageUrl } from '../utils/avatarGenerator';
import { reportError } from '../utils/errorReporter';
import { fetchAllRows, type PagedResult } from '../utils/fetchAllRows';
import { PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import { retryFetch } from '../utils/retryFetch';
import {
  chunkSocialProfileIds,
  formatSocialLastSeen,
  isSocialProfileOnline,
  resolveSocialProfile,
  type SocialGraphProfile,
} from '../utils/socialGraph';
import './FriendsPage.css';

interface Friend {
  id: string;
  user_id: string;
  username: string;
  avatar_url?: string;
  is_online: boolean;
  source_online: boolean;
  last_seen?: string;
  profile_available: boolean;
}

interface FriendshipEdge {
  id: string;
  friend_id?: string;
  user_id?: string;
}

interface ConnectionDiagnostics {
  unavailableProfiles: number;
}

type FriendsTab = 'friends' | 'requests' | 'activity' | 'challenges';

const FRIEND_TABS: Array<{ id: FriendsTab; label: string }> = [
  { id: 'friends', label: 'Friends' },
  { id: 'requests', label: 'Requests' },
  { id: 'activity', label: 'Activity' },
  { id: 'challenges', label: 'Challenges' },
];

const FR_CACHE_PREFIX = 'fr_cache_v2_';
const FR_CACHE_TS_PREFIX = 'fr_cache_v2_ts_';
const FR_CACHE_TTL = 5 * 60 * 1000;
const FRIENDS_PAGE_SIZE = 40;
const SOCIAL_GRAPH_FETCH_SIZE = 500;

async function readCompleteSocialSet<T>(
  label: string,
  makePageQuery: (from: number, to: number) => PromiseLike<PagedResult<T>>,
  isMounted: { current: boolean }
): Promise<T[]> {
  const result = await retryFetch(
    async () => {
      try {
        return {
          data: await fetchAllRows<T>(makePageQuery, {
            pageSize: SOCIAL_GRAPH_FETCH_SIZE,
            label,
          }),
          error: null,
        };
      } catch (error) {
        return {
          data: null,
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
    { maxRetries: 2, isMountedRef: isMounted }
  );

  if (result.error) throw new Error(result.error.message);
  return result.data || [];
}

function getFriendsTab(value: string | null): FriendsTab {
  if (value === 'pending') return 'requests';
  if (value === 'recent') return 'activity';
  return FRIEND_TABS.some((tab) => tab.id === value) ? (value as FriendsTab) : 'friends';
}

function getCachedFriends(userId: string): Friend[] | null {
  try {
    const tsRaw = sessionStorage.getItem(FR_CACHE_TS_PREFIX + userId);
    if (tsRaw && Date.now() - Number.parseInt(tsRaw, 10) > FR_CACHE_TTL) {
      sessionStorage.removeItem(FR_CACHE_PREFIX + userId);
      sessionStorage.removeItem(FR_CACHE_TS_PREFIX + userId);
      return null;
    }
    const raw = sessionStorage.getItem(FR_CACHE_PREFIX + userId);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setCachedFriends(userId: string, data: Friend[]) {
  try {
    sessionStorage.setItem(FR_CACHE_PREFIX + userId, JSON.stringify(data));
    sessionStorage.setItem(FR_CACHE_TS_PREFIX + userId, String(Date.now()));
  } catch {
    // A full session cache must never block the live friends experience.
  }
}

export default function FriendsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuthUser();
  const toast = useToast();
  const isMounted = useIsMounted();
  const activeTab = getFriendsTab(searchParams.get('tab'));
  const [friends, setFriends] = useState<Friend[]>([]);
  const [pendingRequests, setPendingRequests] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleFriendCount, setVisibleFriendCount] = useState(FRIENDS_PAGE_SIZE);
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [connectionDiagnostics, setConnectionDiagnostics] = useState<ConnectionDiagnostics>({
    unavailableProfiles: 0,
  });
  const [challengeTarget, setChallengeTarget] = useState<{ id: string; name: string } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Friend | null>(null);
  const [removingFriend, setRemovingFriend] = useState(false);
  const loadFriendsRef = useRef(async () => {});
  const hasDataRef = useRef(false);
  const loadingRef = useRef(false);

  useEffect(() => {
    document.title = 'Community Connections | Smarter Poker';
  }, []);

  useEffect(() => {
    setVisibleFriendCount(FRIENDS_PAGE_SIZE);
  }, [searchQuery]);

  useEffect(() => {
    const legacyTab = searchParams.get('tab');
    if (legacyTab !== 'pending' && legacyTab !== 'recent') return;
    const next = new URLSearchParams(searchParams);
    next.set('tab', getFriendsTab(legacyTab));
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const selectTab = (tab: FriendsTab) => {
    const next = new URLSearchParams(searchParams);
    if (tab === 'friends') next.delete('tab');
    else next.set('tab', tab);
    setSearchParams(next);
  };

  useEffect(() => {
    if (!user?.id) return;
    const cached = getCachedFriends(user.id);
    if (cached && cached.length > 0) {
      setFriends(cached);
      setConnectionDiagnostics({
        unavailableProfiles: cached.filter((friend) => !friend.profile_available).length,
      });
      hasDataRef.current = true;
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setLoading(false), 5000);
    return () => window.clearTimeout(timeout);
  }, []);

  useVisibilityRefresh(() => loadFriendsRef.current());

  useEffect(() => {
    if (user?.id) loadFriendsRef.current();
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    const presenceKey = 'global-presence';
    const channel = masterBus.getOrCreateChannel(presenceKey);

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        const onlineIds = new Set<string>();
        Object.values(state).forEach((presences) => {
          (presences as unknown as Array<{ user_id: string }>).forEach((presence) => {
            if (presence.user_id) onlineIds.add(presence.user_id);
          });
        });
        setOnlineUserIds(onlineIds);
      })
      .subscribe(async (status: string, error?: Error) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ user_id: user.id, online_at: new Date().toISOString() });
        } else if (status === 'CHANNEL_ERROR' && error) {
          reportError(error.message || error, 'FriendsPage._Presence_channel_error');
        } else if (status === 'TIMED_OUT') {
          console.warn('[FriendsPage] Presence channel timed out');
        }
      });

    return () => {
      masterBus.removeRegisteredChannel(presenceKey);
    };
  }, [user?.id]);

  const handleFriendRequest = useCallback(() => {
    loadFriendsRef.current();
    toast.success('New friend request received!');
  }, [toast]);

  useMasterBusChannel({
    channelName: user?.id ? `friend-requests-${user.id}` : null,
    table: 'friendships',
    filter: user?.id ? `friend_id=eq.${user.id}` : null,
    event: 'INSERT',
    onPayload: handleFriendRequest,
    enabled: !!user?.id,
  });

  useEffect(() => {
    let active = true;
    const handler = () => {
      if (!active) return;
      setIsRefreshing(true);
      loadFriendsRef.current().finally(() => {
        if (active) setIsRefreshing(false);
      });
    };
    const unsubs = [
      masterBus.subscribeDebounced('FRIEND_REQUEST_ACCEPTED', handler, 500),
      masterBus.subscribeDebounced('FRIEND_REQUEST_SENT', handler, 500),
      masterBus.subscribeDebounced('PROFILE_UPDATED', handler, 500),
      masterBus.subscribeDebounced('USER_BLOCKED', handler, 500),
      masterBus.subscribeDebounced('USER_UNBLOCKED', handler, 500),
    ];
    return () => {
      active = false;
      unsubs.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  const loadFriends = useCallback(
    async (getIsMounted?: () => boolean) => {
      if (!user?.id || loadingRef.current) return;
      loadingRef.current = true;
      if (!hasDataRef.current) setLoading(true);

      try {
        const [sentRows, receivedRows, pendingRows] = await Promise.all([
          readCompleteSocialSet<FriendshipEdge>(
            'FriendsPage.accepted_sent',
            (from, to) =>
              supabase
                .from('friendships')
                .select('id, friend_id, status')
                .eq('user_id', user.id)
                .eq('status', 'accepted')
                .order('created_at', { ascending: false })
                .range(from, to),
            isMounted
          ),
          readCompleteSocialSet<FriendshipEdge>(
            'FriendsPage.accepted_received',
            (from, to) =>
              supabase
                .from('friendships')
                .select('id, user_id, status')
                .eq('friend_id', user.id)
                .eq('status', 'accepted')
                .order('created_at', { ascending: false })
                .range(from, to),
            isMounted
          ),
          readCompleteSocialSet<FriendshipEdge>(
            'FriendsPage.pending_received',
            (from, to) =>
              supabase
                .from('friendships')
                .select('id, user_id')
                .eq('friend_id', user.id)
                .eq('status', 'pending')
                .order('created_at', { ascending: false })
                .range(from, to),
            isMounted
          ),
        ]);

        const sentFriendIds = sentRows.map((item) => item.friend_id).filter(Boolean) as string[];
        const receivedFriendIds = receivedRows
          .map((item) => item.user_id)
          .filter(Boolean) as string[];
        const pendingUserIds = pendingRows.map((item) => item.user_id).filter(Boolean) as string[];
        const allProfileIds = [
          ...new Set([...sentFriendIds, ...receivedFriendIds, ...pendingUserIds]),
        ];
        const profileMap = new Map<string, SocialGraphProfile>();

        if (allProfileIds.length > 0) {
          const batches = await Promise.all(
            chunkSocialProfileIds(allProfileIds).map((ids) =>
              retryFetch(
                () =>
                  supabase
                    .from('profiles')
                    .select(
                      `id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url, is_online, last_seen`
                    )
                    .in('id', ids),
                { maxRetries: 2, isMountedRef: isMounted }
              )
            )
          );
          for (const batch of batches) {
            if (batch.error) throw batch.error;
            for (const profile of batch.data || []) {
              profileMap.set(profile.id, profile as SocialGraphProfile);
            }
          }
        }

        const sentMapped = sentRows.map((friendship) => ({
          id: friendship.id,
          friendId: friendship.friend_id,
        }));
        const receivedMapped = receivedRows.map((friendship) => ({
          id: friendship.id,
          friendId: friendship.user_id,
        }));
        const unique = new Map<string, Friend>();

        [...sentMapped, ...receivedMapped].forEach((friendship) => {
          if (!friendship.friendId || unique.has(friendship.friendId)) return;
          const resolved = resolveSocialProfile(profileMap.get(friendship.friendId));
          unique.set(friendship.friendId, {
            id: friendship.id,
            user_id: friendship.friendId,
            username: resolved.name,
            avatar_url: resolved.avatarUrl,
            last_seen: resolved.lastSeen,
            source_online: resolved.sourceOnline,
            profile_available: resolved.available,
            is_online: isSocialProfileOnline(
              friendship.friendId,
              onlineUserIds,
              resolved.sourceOnline,
              resolved.lastSeen
            ),
          });
        });

        if ((getIsMounted && !getIsMounted()) || !isMounted.current) return;
        const nextFriends = Array.from(unique.values());
        setFriends(nextFriends);
        setCachedFriends(user.id, nextFriends);
        setConnectionDiagnostics({
          unavailableProfiles: nextFriends.filter((friend) => !friend.profile_available).length,
        });
        hasDataRef.current = nextFriends.length > 0;
        setPendingRequests(
          pendingRows
            .filter((request) => request.user_id)
            .map((request) => {
              const requestUserId = request.user_id as string;
              const resolved = resolveSocialProfile(profileMap.get(requestUserId));
              return {
                id: request.id,
                user_id: requestUserId,
                username: resolved.name,
                avatar_url: resolved.avatarUrl,
                last_seen: resolved.lastSeen,
                source_online: resolved.sourceOnline,
                profile_available: resolved.available,
                is_online: isSocialProfileOnline(
                  requestUserId,
                  onlineUserIds,
                  resolved.sourceOnline,
                  resolved.lastSeen
                ),
              };
            })
        );
      } catch (error) {
        reportError(error, 'FriendsPage.Failed_to_load_friends');
        toast.error('Failed to load friends');
      } finally {
        loadingRef.current = false;
        if ((!getIsMounted || getIsMounted()) && isMounted.current) setLoading(false);
      }
    },
    [isMounted, onlineUserIds, toast, user?.id]
  );

  useEffect(() => {
    loadFriendsRef.current = loadFriends;
  }, [loadFriends]);

  useEffect(() => {
    if (user?.id && !hasDataRef.current) loadFriends();
  }, [loadFriends, user?.id]);

  const acceptRequest = async (friendshipId: string) => {
    try {
      const { error } = await supabase
        .from('friendships')
        .update({ status: 'accepted' })
        .eq('id', friendshipId)
        .eq('friend_id', user?.id);
      if (error) throw error;
      masterBus.emit('FRIEND_REQUEST_ACCEPTED', { friendshipId });
      await loadFriends();
      toast.success('Friend request accepted!');
    } catch (error) {
      reportError(error, 'FriendsPage.Failed_to_accept_request');
      toast.error('Failed to accept request');
    }
  };

  const declineRequest = async (friendshipId: string) => {
    try {
      const { error } = await supabase
        .from('friendships')
        .delete()
        .eq('id', friendshipId)
        .eq('friend_id', user?.id);
      if (error) throw error;
      await loadFriends();
      toast.success('Friend request declined');
    } catch (error) {
      reportError(error, 'FriendsPage.Failed_to_decline_request');
      toast.error('Failed to decline request');
    }
  };

  const removeFriend = async () => {
    if (!removeTarget) return;
    setRemovingFriend(true);
    try {
      const { error } = await supabase
        .from('friendships')
        .delete()
        .eq('id', removeTarget.id)
        .or(`user_id.eq.${user?.id},friend_id.eq.${user?.id}`);
      if (error) throw error;
      setRemoveTarget(null);
      await loadFriends();
      toast.success('Friend removed');
    } catch (error) {
      reportError(error, 'FriendsPage.Failed_to_remove_friend');
      toast.error('Failed to remove friend');
    } finally {
      if (isMounted.current) setRemovingFriend(false);
    }
  };

  const friendsWithStatus = friends.map((friend) => ({
    ...friend,
    is_online: isSocialProfileOnline(
      friend.user_id,
      onlineUserIds,
      friend.source_online,
      friend.last_seen
    ),
  }));
  const filteredFriends = friendsWithStatus.filter((friend) =>
    friend.username.toLowerCase().includes(searchQuery.trim().toLowerCase())
  );
  const onlineFriends = filteredFriends.filter((friend) => friend.is_online);
  const offlineFriends = filteredFriends.filter((friend) => !friend.is_online);
  const visibleFriends = [...onlineFriends, ...offlineFriends].slice(0, visibleFriendCount);
  const visibleOnlineFriends = visibleFriends.filter((friend) => friend.is_online);
  const visibleOfflineFriends = visibleFriends.filter((friend) => !friend.is_online);
  const onlineCount = friendsWithStatus.filter((friend) => friend.is_online).length;

  const exportFriends = () => {
    try {
      exportToCSV(filteredFriends, 'friends_list.csv', [
        { key: 'username', label: 'Username' },
        { key: 'is_online', label: 'Online' },
        { key: 'user_id', label: 'User ID' },
      ]);
      toast.success('Friends exported!');
    } catch (error) {
      reportError(error, 'FriendsPage.export');
      toast.error('Export failed');
    }
  };

  return (
    <main className="friends-page">
      <CommunitySurfaceHeader
        eyebrow="Community / Connections"
        title="Your Poker Circle"
        description="Manage relationships, respond to players, track shared activity, and launch friendly competitions without losing the game."
        metrics={[
          { label: 'Friends', value: friends.length },
          { label: 'Online', value: onlineCount, tone: 'live' },
          {
            label: 'Requests',
            value: pendingRequests.length,
            tone: pendingRequests.length ? 'attention' : 'default',
          },
        ]}
        actions={
          <>
            <button
              className="friends-hero-action"
              type="button"
              onClick={() => navigate('/search?type=players')}
            >
              Find Players
            </button>
            <button
              className="friends-hero-action is-primary"
              type="button"
              onClick={() => navigate('/messages')}
            >
              Open Messenger
            </button>
          </>
        }
      />

      <section className="friends-command" aria-labelledby="friends-command-title">
        <div className="friends-command-heading">
          <div>
            <p>Relationship Command</p>
            <h2 id="friends-command-title">Connections</h2>
          </div>
          {isRefreshing && (
            <span className="friends-refreshing" role="status">
              Syncing
            </span>
          )}
        </div>

        <div className="friends-tab-rail" role="tablist" aria-label="Connection Views">
          {FRIEND_TABS.map((tab) => {
            const count =
              tab.id === 'friends'
                ? friends.length
                : tab.id === 'requests'
                  ? pendingRequests.length
                  : null;
            return (
              <button
                key={tab.id}
                id={`friends-tab-${tab.id}`}
                className={activeTab === tab.id ? 'is-active' : ''}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`friends-panel-${tab.id}`}
                onClick={() => selectTab(tab.id)}
              >
                {tab.label}
                {count !== null && <span>{count}</span>}
              </button>
            );
          })}
        </div>

        {activeTab === 'friends' && (
          <div
            id="friends-panel-friends"
            className="friends-panel"
            role="tabpanel"
            aria-labelledby="friends-tab-friends"
          >
            <div className="friends-toolbar">
              <label htmlFor="friends-search">Filter Your Friends</label>
              <div>
                <input
                  id="friends-search"
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search By Player Name"
                />
                {filteredFriends.length > 0 && (
                  <button type="button" onClick={exportFriends}>
                    Export CSV
                  </button>
                )}
              </div>
            </div>

            {connectionDiagnostics.unavailableProfiles > 0 && (
              <div className="friends-integrity-notice" role="status">
                <strong>
                  {connectionDiagnostics.unavailableProfiles} Relationship
                  {connectionDiagnostics.unavailableProfiles === 1 ? '' : 's'} Need Profile Repair
                </strong>
                <span>
                  These Records Remain Removable, But Profile, Message, And Challenge Actions Stay
                  Disabled Until A Valid Player Profile Resolves.
                </span>
              </div>
            )}

            {loading ? (
              <div className="friends-skeleton-list" role="status" aria-label="Loading Friends">
                {Array.from({ length: 5 }).map((_, index) => (
                  <div className="friends-skeleton-row" key={index}>
                    <span />
                    <div>
                      <i />
                      <i />
                    </div>
                  </div>
                ))}
              </div>
            ) : filteredFriends.length === 0 ? (
              <div className="friends-empty">
                <span aria-hidden="true">◇</span>
                <h3>{searchQuery ? 'No friends match that name' : 'Build your poker circle'}</h3>
                <p>
                  {searchQuery
                    ? 'Clear the filter or search the wider community.'
                    : 'Find players you trust, then message, challenge, and follow their activity here.'}
                </p>
                <button type="button" onClick={() => navigate('/search?type=players')}>
                  Find Players
                </button>
              </div>
            ) : (
              <div className="friends-groups">
                {visibleOnlineFriends.length > 0 && (
                  <FriendGroup
                    label="Online now"
                    friends={visibleOnlineFriends}
                    totalCount={onlineFriends.length}
                    navigate={navigate}
                    onMessage={(friend) => navigate(`/messages?compose=${friend.user_id}`)}
                    onChallenge={(friend) =>
                      setChallengeTarget({ id: friend.user_id, name: friend.username })
                    }
                    onRemove={setRemoveTarget}
                  />
                )}
                {visibleOfflineFriends.length > 0 && (
                  <FriendGroup
                    label="Offline"
                    friends={visibleOfflineFriends}
                    totalCount={offlineFriends.length}
                    navigate={navigate}
                    onMessage={(friend) => navigate(`/messages?compose=${friend.user_id}`)}
                    onChallenge={(friend) =>
                      setChallengeTarget({ id: friend.user_id, name: friend.username })
                    }
                    onRemove={setRemoveTarget}
                  />
                )}
                {visibleFriends.length < filteredFriends.length && (
                  <div className="friends-load-more">
                    <span aria-live="polite">
                      Showing {visibleFriends.length} Of {filteredFriends.length} Friends
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setVisibleFriendCount((current) => current + FRIENDS_PAGE_SIZE)
                      }
                    >
                      Load{' '}
                      {Math.min(FRIENDS_PAGE_SIZE, filteredFriends.length - visibleFriends.length)}{' '}
                      More
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'requests' && (
          <div
            id="friends-panel-requests"
            className="friends-panel"
            role="tabpanel"
            aria-labelledby="friends-tab-requests"
          >
            {pendingRequests.length === 0 ? (
              <div className="friends-empty">
                <span aria-hidden="true">⌁</span>
                <h3>No Pending Requests</h3>
                <p>Incoming Connection Requests Will Appear Here With Clear Review Controls.</p>
                <button type="button" onClick={() => navigate('/search?type=players')}>
                  Discover Players
                </button>
              </div>
            ) : (
              <div className="friends-request-list">
                {pendingRequests.map((request) => (
                  <article className="friends-request-row" key={request.id}>
                    <button
                      className="friends-request-profile"
                      type="button"
                      disabled={!request.profile_available}
                      onClick={() =>
                        request.profile_available && navigate(`/profile/${request.user_id}`)
                      }
                    >
                      <FriendAvatar friend={request} />
                      <span>
                        <strong>{request.username}</strong>
                        <small>Wants To Connect</small>
                      </span>
                    </button>
                    <div className="friends-request-actions">
                      <button
                        className="is-accept"
                        type="button"
                        disabled={!request.profile_available}
                        onClick={() => acceptRequest(request.id)}
                      >
                        Accept
                      </button>
                      <button type="button" onClick={() => declineRequest(request.id)}>
                        Decline
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'activity' && (
          <div
            id="friends-panel-activity"
            className="friends-panel friends-activity"
            role="tabpanel"
            aria-labelledby="friends-tab-activity"
          >
            <div className="friends-panel-intro">
              <div>
                <p>Network Pulse</p>
                <h3>Activity & Discovery</h3>
              </div>
              <button type="button" onClick={() => navigate('/search?type=players')}>
                Search All Players
              </button>
            </div>
            <FriendActivityFeed friends={friends} />
            <FriendSuggestions />
          </div>
        )}

        {activeTab === 'challenges' && (
          <div
            id="friends-panel-challenges"
            className="friends-panel"
            role="tabpanel"
            aria-labelledby="friends-tab-challenges"
          >
            {user?.id ? (
              <FriendChallengesPanel userId={user.id} />
            ) : (
              <div className="friends-empty">
                <p>Sign In To View Friend Challenges.</p>
              </div>
            )}
          </div>
        )}
      </section>

      {user?.id && challengeTarget && (
        <FriendChallengeModal
          isOpen
          onClose={() => setChallengeTarget(null)}
          challengerId={user.id}
          challengeeId={challengeTarget.id}
          challengeeName={challengeTarget.name}
        />
      )}

      <ConfirmModal
        isOpen={!!removeTarget}
        onConfirm={removeFriend}
        onCancel={() => setRemoveTarget(null)}
        title="Remove Friend?"
        message={`Remove ${removeTarget?.username || 'this player'} from your poker circle? This does not block them.`}
        confirmText="Remove Friend"
        variant="danger"
        loading={removingFriend}
      />
    </main>
  );
}

interface FriendGroupProps {
  label: string;
  friends: Friend[];
  totalCount: number;
  navigate: (path: string) => void;
  onMessage: (friend: Friend) => void;
  onChallenge: (friend: Friend) => void;
  onRemove: (friend: Friend) => void;
}

function FriendGroup({
  label,
  friends,
  totalCount,
  navigate,
  onMessage,
  onChallenge,
  onRemove,
}: FriendGroupProps) {
  return (
    <section
      className="friend-group"
      aria-labelledby={`friend-group-${label.replace(/\s/g, '-').toLowerCase()}`}
    >
      <h3 id={`friend-group-${label.replace(/\s/g, '-').toLowerCase()}`}>
        {label}
        <span>{totalCount}</span>
      </h3>
      <div className="friend-group-list">
        {friends.map((friend) => (
          <article className="friend-row" key={friend.id}>
            <button
              className="friend-profile"
              type="button"
              disabled={!friend.profile_available}
              onClick={() => friend.profile_available && navigate(`/profile/${friend.user_id}`)}
            >
              <FriendAvatar friend={friend} />
              <span className="friend-copy">
                <strong>{friend.username}</strong>
                <small>
                  {!friend.profile_available
                    ? 'Connection record only'
                    : friend.is_online
                      ? 'Online now'
                      : formatSocialLastSeen(friend.last_seen)}
                </small>
              </span>
            </button>
            <div
              className={`friend-actions ${friend.profile_available ? '' : 'is-unavailable'}`}
              aria-label={`Actions For ${friend.username}`}
            >
              {friend.profile_available && (
                <>
                  <button className="is-primary" type="button" onClick={() => onMessage(friend)}>
                    Message
                  </button>
                  <button type="button" onClick={() => onChallenge(friend)}>
                    Challenge
                  </button>
                </>
              )}
              <button className="is-danger" type="button" onClick={() => onRemove(friend)}>
                Remove
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function FriendAvatar({ friend }: { friend: Friend }) {
  return (
    <span className="friend-avatar">
      {friend.avatar_url ? (
        <img
          src={sizedStorageUrl(friend.avatar_url, 56)}
          alt=""
          loading="lazy"
          onError={(event) => {
            event.currentTarget.onerror = null;
            event.currentTarget.src = generateAvatarSvg(
              friend.user_id || friend.username,
              friend.username
            );
          }}
        />
      ) : (
        <span aria-hidden="true">{friend.username[0]?.toUpperCase()}</span>
      )}
      {friend.is_online && <i aria-label="Online" />}
    </span>
  );
}
