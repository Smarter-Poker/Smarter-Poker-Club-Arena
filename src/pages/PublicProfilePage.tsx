/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PUBLIC PROFILE PAGE — View Another Player's Profile
 * ═══════════════════════════════════════════════════════════════════════════════
 * Shows: avatar, username, bio, VIP tier, level, stats, achievements,
 * mutual friends, and action buttons (Add Friend, Message, Block)
 */

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { profileService } from '../services/ProfileService';
import type { UserProfile, ProfileStats } from '../services/ProfileService';
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

// VIP tier colors
const VIP_COLORS: Record<string, string> = {
  bronze: '#cd7f32',
  silver: '#c0c0c0',
  gold: '#ffd700',
  platinum: '#e5e4e2',
  diamond: '#b9f2ff',
};

const VIP_LABELS: Record<string, string> = {
  bronze: '🥉 Bronze',
  silver: '🥈 Silver',
  gold: '🥇 Gold',
  platinum: '💎 Platinum',
  diamond: '♦️ Diamond',
};

export default function PublicProfilePage() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [stats, setStats] = useState<ProfileStats | null>(null);
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

  useVisibilityRefresh(() => loadProfile());
  const loadProfile = useCallback(async () => {
    if (!userId || !user?.id) return;

    // If viewing own profile, redirect
    if (userId === user.id) {
      navigate('/profile', { replace: true });
      return;
    }

    setLoading(true);
    try {
      const [profileData, statsData, mutuals, blocked, friendship, status] = await Promise.all([
        profileService.getPublicProfile(userId),
        profileService.getStats(userId),
        friendSuggestionService.getMutualFriends(user.id, userId),
        blockService.isBlocked(user.id, userId),
        checkFriendship(user.id, userId),
        playerStatusService.getPlayerStatus(userId),
      ]);

      setProfile(profileData);
      setStats(statsData);
      setMutualFriends(mutuals);
      setIsBlocked(blocked);
      setFriendStatus(friendship);
      setPlayerStatus(status);
    } catch (err) {
      console.error('[PublicProfile] Load error:', err);
      toast.error('Failed to load profile');
    }
    setLoading(false);
  }, [userId, user?.id]);

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
          checkFriendship(user.id, userId).then(setFriendStatus);
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
          playerStatusService.getPlayerStatus(userId).then(setPlayerStatus);
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
    const { data, error } = await supabase
      .from('friendships')
      .select('status, user_id')
      .or(
        `and(user_id.eq.${myId},friend_id.eq.${theirId}),and(user_id.eq.${theirId},friend_id.eq.${myId})`
      )
      .maybeSingle();
    if (error) console.error('[PublicProfile] Friendship check failed:', error.message);

    if (!data) return 'none';
    if (data.status === 'accepted') return 'friends';
    if (data.status === 'pending') {
      return data.user_id === myId ? 'pending_sent' : 'pending_received';
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
      setFriendStatus('pending_sent');
      masterBus.emit('FRIEND_REQUEST_SENT', { fromUserId: user.id, toUserId: userId });
      toast.success('Friend request sent!');
    } catch (err) {
      console.error('[PublicProfile] Add friend error:', err);
      toast.error('Failed to send friend request');
    }
    setActionLoading(false);
  };

  // Accept friend request
  const handleAcceptFriend = async () => {
    if (!user?.id || !userId) return;
    setActionLoading(true);
    try {
      const { error } = await supabase
        .from('friendships')
        .update({ status: 'accepted' })
        .or(`and(user_id.eq.${userId},friend_id.eq.${user.id})`)
        .eq('status', 'pending');
      if (error) throw error;
      setFriendStatus('friends');
      masterBus.emit('FRIEND_REQUEST_ACCEPTED', { userId: user.id, friendId: userId });
      toast.success('Friend request accepted!');
    } catch (err) {
      console.error('[PublicProfile] Accept friend error:', err);
      toast.error('Failed to accept request');
    }
    setActionLoading(false);
  };

  // Start or resume a DM conversation
  const handleMessage = async () => {
    if (!user?.id || !userId) return;
    setActionLoading(true);
    try {
      const conv = await messagingService.startConversation(user.id, userId);
      if (conv) {
        navigate(`/messages/${conv.id}`);
      } else {
        toast.error('Failed to start conversation');
      }
    } catch (err) {
      console.error('[PublicProfile] Message error:', err);
      toast.error('Failed to start conversation');
    }
    setActionLoading(false);
  };

  // Block confirmed
  const handleBlockConfirm = async (reason?: string) => {
    if (!user?.id || !userId) return;
    const success = await blockService.blockUser(user.id, userId, reason);
    if (success) {
      setIsBlocked(true);
      setShowBlockModal(false);
      toast.success('Player blocked');
    } else {
      toast.error('Failed to block player');
    }
  };

  // Unblock
  const handleUnblock = async () => {
    if (!user?.id || !userId) return;
    const success = await blockService.unblockUser(user.id, userId);
    if (success) {
      setIsBlocked(false);
      toast.success('Player unblocked');
    }
  };

  if (loading) {
    return (
      <div className="public-profile-page">
        <div className="public-profile-loading">
          <PageSkeleton variant="default" />
          <p>Loading profile...</p>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="public-profile-page">
        <div className="public-profile-empty">
          <span className="empty-icon">👤</span>
          <h2>Player Not Found</h2>
          <p>This player doesn't exist or their profile is hidden.</p>
          <button className="back-btn" onClick={() => navigate(-1)}>
            ← Go Back
          </button>
        </div>
      </div>
    );
  }

  const memberSince = new Date(profile.createdAt).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="public-profile-page">
      {/* Header with avatar & name */}
      <div className="public-profile-header">
        <button className="back-btn" onClick={() => navigate(-1)}>
          ←
        </button>
        <div className="profile-hero">
          <PlayerAvatar
            src={profile.avatarUrl || '/default-avatar.png'}
            name={profile.username}
            size="xl"
            showPresence={false}
            showLevelBadge={true}
            level={profile.level}
            showXpRing={false}
            showVipRing={true}
            vipTier={profile.vipTier}
          />
          <h1 className="profile-username">{profile.displayName || profile.username}</h1>
          <span className="profile-handle">@{profile.username}</span>
          {profile.bio && <p className="profile-bio">{profile.bio}</p>}
          <div className="profile-badges">
            <span className="vip-badge" style={{ color: VIP_COLORS[profile.vipTier] || '#cd7f32' }}>
              {VIP_LABELS[profile.vipTier] || '🥉 Bronze'}
            </span>
            <span className="level-badge">Level {profile.level}</span>
            <span className="member-since">Member since {memberSince}</span>
          </div>

          {/* Q3: Playing-At & Status */}
          {playerStatus?.playingAt && (
            <div
              className="playing-at-badge"
              onClick={() =>
                playerStatus.playingAtTableId && navigate(`/table/${playerStatus.playingAtTableId}`)
              }
            >
              🎯 Playing at <strong>{playerStatus.playingAt}</strong>
            </div>
          )}
          {playerStatus?.statusText && (
            <p className="player-status-text">{playerStatus.statusText}</p>
          )}
        </div>
      </div>

      {/* Action Buttons */}
      <div className="profile-actions">
        {isBlocked ? (
          <button
            className="action-btn unblock-btn"
            onClick={handleUnblock}
            disabled={actionLoading}
          >
            🚫 Unblock
          </button>
        ) : (
          <>
            {friendStatus === 'none' && (
              <button
                className="action-btn add-friend-btn"
                onClick={handleAddFriend}
                disabled={actionLoading}
              >
                👥 Add Friend
              </button>
            )}
            {friendStatus === 'pending_sent' && (
              <button className="action-btn pending-btn" disabled>
                ⏳ Request Sent
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
              ✉ Message
            </button>
            <button className="action-btn block-btn" onClick={() => setShowBlockModal(true)}>
              🚫
            </button>
            <button
              className="action-btn share-btn"
              onClick={() => {
                const link = playerStatusService.generateProfileLink(userId!);
                navigator.clipboard.writeText(link);
                toast.success('Profile link copied!');
              }}
            >
              📤 Share
            </button>
          </>
        )}
      </div>

      {/* Stats Grid */}
      {stats && (
        <div className="profile-stats-grid">
          <div className="stat-card">
            <span className="stat-value">{stats.totalHands.toLocaleString()}</span>
            <span className="stat-label">Hands Played</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{stats.winRate.toFixed(1)}%</span>
            <span className="stat-label">Win Rate</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{stats.biggestWin.toLocaleString()}</span>
            <span className="stat-label">Biggest Win</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{profile.tournamentsWon}</span>
            <span className="stat-label">Tournaments Won</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{profile.currentStreak}</span>
            <span className="stat-label">Current Streak 🔥</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{stats.favoriteVariant}</span>
            <span className="stat-label">Favorite Game</span>
          </div>
        </div>
      )}

      {/* Mutual Friends */}
      {mutualFriends.length > 0 && (
        <div className="mutual-friends-section">
          <h3>
            👥 {mutualFriends.length} Mutual Friend{mutualFriends.length !== 1 ? 's' : ''}
          </h3>
          <div className="mutual-friends-list">
            {mutualFriends.slice(0, 6).map((friend) => (
              <div
                key={friend.id}
                className="mutual-friend-chip"
                onClick={() => navigate(`/profile/${friend.id}`)}
              >
                <img
                  src={friend.avatarUrl || '/default-avatar.png'}
                  alt={friend.username}
                  className="mutual-avatar"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = '/default-avatar.png';
                  }}
                />
                <span>{friend.username}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Q3: Achievement Showcase */}
      {(profile as any).achievements && (profile as any).achievements.length > 0 && (
        <div className="achievement-showcase">
          <h3>🏆 Achievement Showcase</h3>
          <div className="achievement-grid">
            {(profile as any).achievements.slice(0, 5).map((achievement: any, i: number) => (
              <div key={i} className="achievement-card">
                <span className="achievement-icon">{achievement.icon || '🏅'}</span>
                <span className="achievement-name">{achievement.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Q3: Profile QR Code */}
      {userId && (
        <div className="profile-qr-section">
          <h3>📱 Scan to Connect</h3>
          <img
            src={messagingService.generateProfileQRData(userId)}
            alt="Profile QR Code"
            className="profile-qr-image"
          />
          <p className="qr-hint">Scan at the table to add as friend</p>
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
    </div>
  );
}
