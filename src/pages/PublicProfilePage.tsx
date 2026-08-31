/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PUBLIC PROFILE PAGE — View Another Player's Profile
 * ═══════════════════════════════════════════════════════════════════════════════
 * Shows: avatar, username, bio, VIP tier, level, achievements,
 * mutual friends, and action buttons (Add Friend, Message, Block)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useIsMounted } from '../hooks/useIsMounted';
import { useParams, useNavigate } from 'react-router-dom';
import { profileService } from '../services/ProfileService';
import type { UserProfile } from '../services/ProfileService';
import { friendSuggestionService } from '../services/FriendSuggestionService';
import { blockService } from '../services/BlockService';
import { messagingService } from '../services/MessagingService';
import { playerStatusService } from '../services/PlayerStatusService';
import type { PlayerStatus } from '../services/PlayerStatusService';
import { useAuthUser } from '../hooks/useAuthUser';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useToast } from '../components/common/Toast';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { PlayerAvatar } from '../components/avatars/PlayerAvatar';
import PlayerBlockModal from '../components/social/PlayerBlockModal';
import './PublicProfilePage.css';
import PageSkeleton from '../components/common/PageSkeleton';
import { generateDefaultAvatar } from '../utils/avatarGenerator';
import { reportError } from '../utils/errorReporter';

// VIP tier colors
const VIP_COLORS: Record<string, string> = {
  bronze: '#cd7f32',
  silver: '#c0c0c0',
  gold: '#ffd700',
  platinum: '#e5e4e2',
  diamond: '#b9f2ff',
};

const VIP_LABELS: Record<string, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  platinum: 'Platinum',
  diamond: '♦ Diamond',
};

export default function PublicProfilePage() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const isMounted = useIsMounted();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [mutualFriends, setMutualFriends] = useState<
    { id: string; username: string; avatarUrl?: string }[]
  >([]);
  const [friendStatus, setFriendStatus] = useState<
    'none' | 'pending_sent' | 'pending_received' | 'friends'
  >('none');
  const [isBlocked, setIsBlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showBlockModal, setShowBlockModal] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus | null>(null);

  const loadingRef = useRef(false);

  useEffect(() => {
    document.title = profile
      ? `${profile.displayName || profile.username} | Smarter Poker`
      : 'Player Profile | Smarter Poker';
  }, [profile]);

  useVisibilityRefresh(() => loadProfile());
  const loadProfile = useCallback(async () => {
    if (!userId || !user?.id) return;

    // If viewing own profile, redirect
    if (userId === user.id) {
      navigate('/profile', { replace: true });
      return;
    }

    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const [profileData, mutuals, blocked, friendship, status] = await Promise.all([
        profileService.getPublicProfile(userId),
        friendSuggestionService.getMutualFriends(user.id, userId),
        blockService.isBlocked(user.id, userId),
        checkFriendship(user.id, userId),
        playerStatusService.getPlayerStatus(userId),
      ]);

      if (!isMounted.current) return;
      setProfile(profileData);
      setMutualFriends(mutuals);
      setIsBlocked(blocked);
      setFriendStatus(friendship);
      setPlayerStatus(status);
    } catch (err) {
      reportError(err, 'PublicProfilePage.Load_error');
      if (isMounted.current) toast.error('Failed to load profile');
    } finally {
      loadingRef.current = false;
      if (isMounted.current) setLoading(false);
    }
  }, [isMounted, navigate, toast, userId, user?.id]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  // Bus listeners: real-time friend/block state sync
  useEffect(() => {
    const unsubFriend = masterBus.subscribeDebounced(
      'FRIEND_REQUEST_ACCEPTED',
      () => {
        // Re-check friendship status when any request is accepted
        if (user?.id && userId) {
          checkFriendship(user.id, userId)
            .then(setFriendStatus)
            .catch((e) => console.warn('[PublicProfile] Friendship check failed:', e));
        }
      },
      300
    );
    const unsubFriendSent = masterBus.subscribeDebounced(
      'FRIEND_REQUEST_SENT',
      (event) => {
        if (event.payload?.toUserId === userId) {
          setFriendStatus('pending_sent');
        }
      },
      300
    );
    const unsubBlock = masterBus.subscribeDebounced(
      'USER_BLOCKED',
      (event) => {
        if (event.payload?.blockedUserId === userId) {
          setIsBlocked(true);
        }
      },
      300
    );
    const unsubUnblock = masterBus.subscribeDebounced(
      'USER_UNBLOCKED',
      (event) => {
        if (event.payload?.unblockedUserId === userId) {
          setIsBlocked(false);
        }
      },
      300
    );
    // Q3 Phase 10: Refresh player status when profile is updated
    const unsubProfile = masterBus.subscribeDebounced(
      'PROFILE_UPDATED',
      (event) => {
        if (event.payload?.userId === userId) {
          playerStatusService
            .getPlayerStatus(userId)
            .then(setPlayerStatus)
            .catch((e) => console.warn('[PublicProfile] Player status refresh failed:', e));
        }
      },
      500
    );
    return () => {
      unsubFriend();
      unsubFriendSent();
      unsubBlock();
      unsubUnblock();
      unsubProfile();
    };
  }, [userId, user?.id]);

  // Check friendship status
  async function checkFriendship(
    myId: string,
    theirId: string
  ): Promise<'none' | 'pending_sent' | 'pending_received' | 'friends'> {
    const { data: friendshipRows, error } = await supabase
      .from('friendships')
      .select('status, user_id')
      .or(
        `and(user_id.eq.${myId},friend_id.eq.${theirId}),and(user_id.eq.${theirId},friend_id.eq.${myId})`
      )
      // Accepted relationships can be stored in both directions. Asking
      // PostgREST for maybeSingle() turns that valid reciprocal pair into a
      // PGRST116 error, so inspect the bounded pair instead.
      .limit(2);
    if (error) {
      reportError(error, 'PublicProfilePage.Friendship_check_failed');
      return 'none';
    }

    if (!friendshipRows?.length) return 'none';
    if (friendshipRows.some((row) => row.status === 'accepted')) return 'friends';

    const pending = friendshipRows.find((row) => row.status === 'pending');
    if (pending) {
      return pending.user_id === myId ? 'pending_sent' : 'pending_received';
    }
    return 'none';
  }

  // Send friend request
  const handleAddFriend = async () => {
    if (!user?.id || !userId) return;
    setActionLoading(true);
    try {
      const { error } = await supabase.from('friendships').insert({
        user_id: user.id,
        friend_id: userId,
        status: 'pending',
      });
      if (error) throw error;
      if (!isMounted.current) return;
      setFriendStatus('pending_sent');
      masterBus.emit('FRIEND_REQUEST_SENT', { fromUserId: user.id, toUserId: userId });
      if (isMounted.current) toast.success('Friend request sent!');
    } catch (err) {
      reportError(err, 'PublicProfilePage.Add_friend_error');
      if (isMounted.current) toast.error('Failed to send friend request');
    }
    if (isMounted.current) setActionLoading(false);
  };

  // Accept friend request
  const handleAcceptFriend = async () => {
    if (!user?.id || !userId) return;
    setActionLoading(true);
    try {
      const { data: pending, error: lookupError } = await supabase
        .from('friendships')
        .select('id')
        .eq('user_id', userId)
        .eq('friend_id', user.id)
        .eq('status', 'pending')
        .limit(1);
      if (lookupError) throw lookupError;
      const pendingId = pending?.[0]?.id;
      if (!pendingId) throw new Error('Friend request is no longer pending');
      const { data, error } = await supabase.rpc('accept_friendship', {
        p_friendship_id: pendingId,
      });
      if (error) throw error;
      if (data?.success !== true) throw new Error(data?.error || 'Friend request was not accepted');
      if (!isMounted.current) return;
      setFriendStatus('friends');
      masterBus.emit('FRIEND_REQUEST_ACCEPTED', { userId: user.id, friendId: userId });
      if (isMounted.current) toast.success('Friend request accepted!');
    } catch (err) {
      reportError(err, 'PublicProfilePage.Accept_friend_error');
      if (isMounted.current) toast.error('Failed to accept request');
    }
    if (isMounted.current) setActionLoading(false);
  };

  // Message this player — uses compose deep-link into the embedded messenger.
  // The messenger already has full 'start or resume conversation' logic internally
  // (router.query.uid path in messenger.js line 2721), so no pre-flight Supabase
  // call is needed. This saves a round-trip and eliminates the old broken
  // navigate('/messages/:convId') pattern that pointed at a non-existent route.
  const handleMessage = () => {
    if (!userId) return;
    navigate(`/messages?compose=${userId}`);
  };

  // Block confirmed
  const handleBlockConfirm = async (reason?: string) => {
    if (!user?.id || !userId) return;
    const success = await blockService.blockUser(user.id, userId, reason);
    if (!isMounted.current) return;
    if (success) {
      setIsBlocked(true);
      setShowBlockModal(false);
      if (isMounted.current) toast.success('Player blocked');
    } else {
      if (isMounted.current) toast.error('Failed to block player');
    }
  };

  // Unblock
  const handleUnblock = async () => {
    if (!user?.id || !userId) return;
    const success = await blockService.unblockUser(user.id, userId);
    if (!isMounted.current) return;
    if (success) {
      setIsBlocked(false);
      if (isMounted.current) toast.success('Player unblocked');
    }
  };

  if (loading) {
    return (
      <div className="public-profile-page">
        <div className="public-profile-loading">
          <PageSkeleton variant="default" />
          <p>Loading Profile...</p>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="public-profile-page">
        <div className="public-profile-empty">
          <span className="empty-icon">◉</span>
          <h2>Player Not Found</h2>
        </div>
      </div>
    );
  }

  const memberSince = new Date(profile.createdAt).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  return (
    <article className="public-profile-page">
      {/* Header with avatar & name */}
      <header className="public-profile-header">
        <div className="public-profile-artwork" aria-hidden="true" />
        <div className="profile-hero">
          <span className="public-profile-eyebrow">Player Network // Public Credential</span>
          <PlayerAvatar
            src={profile.avatarUrl || generateDefaultAvatar()}
            name={profile.username}
            size="xl"
            showPresence={false}
            showLevelBadge={true}
            level={profile.level}
            showVipRing={true}
            vipTier={profile.vipTier}
          />
          <h1 className="profile-username">{profile.displayName || profile.username}</h1>
          <span className="profile-handle">@{profile.username}</span>
          {profile.bio && <p className="profile-bio">{profile.bio}</p>}
          <div className="profile-badges">
            <span className="vip-badge" style={{ color: VIP_COLORS[profile.vipTier] || '#cd7f32' }}>
              {VIP_LABELS[profile.vipTier] || 'Bronze'}
            </span>
            <span className="level-badge">Level {profile.level}</span>
            <span className="member-since">Member Since {memberSince}</span>
          </div>

          {/* Q3: Playing-At & Status */}
          {playerStatus?.playingAt && playerStatus.playingAtTableId ? (
            <button
              type="button"
              className="playing-at-badge"
              onClick={() => navigate(`/table/${playerStatus.playingAtTableId}`)}
            >
              Playing At <strong>{playerStatus.playingAt}</strong>
            </button>
          ) : playerStatus?.playingAt ? (
            <div className="playing-at-badge playing-at-badge--static">
              Playing At <strong>{playerStatus.playingAt}</strong>
            </div>
          ) : null}
          {playerStatus?.statusText && (
            <p className="player-status-text">{playerStatus.statusText}</p>
          )}
        </div>
      </header>

      {/* Action Buttons */}
      <div className="profile-actions">
        {isBlocked ? (
          <button
            className="action-btn unblock-btn"
            onClick={handleUnblock}
            disabled={actionLoading}
          >
            Unblock
          </button>
        ) : (
          <>
            {friendStatus === 'none' && (
              <button
                className="action-btn add-friend-btn"
                onClick={handleAddFriend}
                disabled={actionLoading}
              >
                Add Friend
              </button>
            )}
            {friendStatus === 'pending_sent' && (
              <button className="action-btn pending-btn" disabled>
                Request Sent
              </button>
            )}
            {friendStatus === 'pending_received' && (
              <button
                className="action-btn accept-btn"
                onClick={handleAcceptFriend}
                disabled={actionLoading}
              >
                ✓ Accept Request
              </button>
            )}
            {friendStatus === 'friends' && (
              <button className="action-btn friends-btn" disabled>
                ✓ Friends
              </button>
            )}
            <button
              className="action-btn message-btn"
              onClick={handleMessage}
              disabled={actionLoading}
            >
              Message
            </button>
            <button
              className="action-btn block-btn"
              onClick={() => setShowBlockModal(true)}
              aria-label={`Block ${profile.username}`}
            >
              Block
            </button>
            {/*
              PHASE 7 — the review queue could never receive anything.
              ReportPlayerPage has always written to user_reports, and
              clubs/:clubId/reports has always read it, but nothing anywhere
              linked to the form: user_reports held ZERO rows. This is the
              missing half - staff could review reports no player could file.
            */}
            <button
              className="action-btn report-btn"
              onClick={() => navigate(`/report/${userId}`)}
              aria-label={`Report ${profile.username}`}
            >
              Report
            </button>
            <button
              className="action-btn share-btn"
              onClick={() => {
                const link = playerStatusService.generateProfileLink(userId!);
                navigator.clipboard.writeText(link);
                toast.success('Profile link copied!');
              }}
            >
              Share
            </button>
          </>
        )}
      </div>

      {/* Mutual Friends */}
      {mutualFriends.length > 0 && (
        <div className="mutual-friends-section">
          <h3>
            {mutualFriends.length} Mutual Friend{mutualFriends.length !== 1 ? 's' : ''}
          </h3>
          <div className="mutual-friends-list">
            {mutualFriends.slice(0, 6).map((friend) => (
              <button
                type="button"
                key={friend.id}
                className="mutual-friend-chip"
                onClick={() => navigate(`/profile/${friend.id}`)}
              >
                <img
                  src={friend.avatarUrl || generateDefaultAvatar()}
                  alt={friend.username}
                  className="mutual-avatar"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = generateDefaultAvatar();
                  }}
                />
                <span>{friend.username}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Q3: Achievement Showcase */}
      {(profile as any).achievements && (profile as any).achievements.length > 0 && (
        <div className="achievement-showcase">
          <h3>Achievement Showcase</h3>
          <div className="achievement-grid">
            {(profile as any).achievements.slice(0, 5).map((achievement: any, i: number) => (
              <div key={i} className="achievement-card">
                <span className="achievement-icon">{achievement.icon || '★'}</span>
                <span className="achievement-name">{achievement.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Q3: Profile QR Code */}
      {userId && (
        <div className="profile-qr-section">
          <h3>Scan To Connect</h3>
          <img
            src={messagingService.generateProfileQRData(userId)}
            alt="Profile QR Code"
            className="profile-qr-image"
          />
          <p className="qr-hint">Scan At The Table To Add As Friend</p>
        </div>
      )}

      {/* Block Modal */}
      {showBlockModal && (
        <PlayerBlockModal
          playerName={profile.username}
          onConfirm={handleBlockConfirm}
          onCancel={() => setShowBlockModal(false)}
        />
      )}
    </article>
  );
}
