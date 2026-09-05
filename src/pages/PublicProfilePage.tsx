/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PUBLIC PROFILE PAGE — Another Player's Arena Dossier
 * ═══════════════════════════════════════════════════════════════════════════════
 * Shows: arena avatar and handle, bio, tags, member-since, live table status,
 * the public arena record (player_stats), mutual friends, and the social
 * controls (Add Friend, Message, Block, Report, Share) plus a local QR code.
 *
 * 2026-09-04 audit (#smarterCasinoRealism rebuild). What was wrong before:
 *   - A "Bronze" VIP badge on every player. profiles.tier is "Newcomer" for
 *     all 1,310 rows and vip_points is owner-only, so the badge could only
 *     ever show the fallback. Removed: a tier nobody can read is not shown.
 *   - "Level 1" on every player. profiles.level is 1 for all 1,310 rows.
 *   - An achievement showcase that could never render: the profile mapper
 *     never populated it and training_user_achievements is owner-only.
 *   - The QR code was fetched from api.qrserver.com - every profile view sent
 *     the player's profile URL to a third party. It is drawn locally now.
 *   - Share wrote to the clipboard without awaiting or catching, so a denied
 *     permission surfaced as an unhandled rejection with a "copied" toast.
 *   - The header printed the social `username`; the tables print the arena
 *     handle (alias -> username) and the arena avatar. It shows what the
 *     felt shows now - this is a poker dossier, not a social card.
 *   - No poker record at all. player_stats is public by policy; the dossier
 *     now carries hands, VPIP/PFR and tournament wins across every club.
 */

import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react';
import { useIsMounted } from '../hooks/useIsMounted';
import { useParams, useNavigate } from 'react-router-dom';
import { friendSuggestionService } from '../services/FriendSuggestionService';
import { blockService } from '../services/BlockService';
import { playerStatusService } from '../services/PlayerStatusService';
import type { PlayerStatus } from '../services/PlayerStatusService';
import { useAuthUser } from '../hooks/useAuthUser';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useToast } from '../components/common/Toast';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import PlayerBlockModal from '../components/social/PlayerBlockModal';
import './PublicProfilePage.css';
import PageSkeleton from '../components/common/PageSkeleton';
import { generateDefaultAvatar } from '../utils/avatarGenerator';
import { reportError } from '../utils/errorReporter';
import { lazyWithRetry } from '../utils/lazyWithRetry';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import { formatCount, formatMemberSince, formatPct, relativeTimeTitle } from '../utils/format';
import { mediaUrl } from '../utils/mediaBase';
import { aggregateArenaRecord, type ArenaRecord } from '../utils/arenaRecord';

// The QR renderer is only fetched when a dossier is actually viewed.
const LazyQRCode = lazyWithRetry(() =>
  import('qrcode.react').then((m) => ({ default: m.QRCodeSVG }))
);

interface PublicProfile {
  id: string;
  handle: string;
  username: string;
  avatarUrl: string;
  bio: string;
  createdAt: string;
  playerNumber: number;
  tags: string[];
}

type FriendState = 'none' | 'pending_sent' | 'pending_received' | 'friends';

export default function PublicProfilePage() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const isMounted = useIsMounted();

  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [record, setRecord] = useState<ArenaRecord | null>(null);
  const [mutualFriends, setMutualFriends] = useState<
    { id: string; username: string; avatarUrl?: string }[]
  >([]);
  const [friendStatus, setFriendStatus] = useState<FriendState>('none');
  const [isBlocked, setIsBlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showBlockModal, setShowBlockModal] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus | null>(null);

  const loadingRef = useRef(false);

  useEffect(() => {
    document.title = profile
      ? `${profile.handle} | Smarter Poker`
      : 'Player Profile | Smarter Poker';
  }, [profile]);

  // Check friendship status. Accepted relationships can be stored in both
  // directions, so the bounded pair is inspected rather than a single row.
  const checkFriendship = useCallback(
    async (myId: string, theirId: string): Promise<FriendState> => {
      const { data: friendshipRows, error } = await supabase
        .from('friendships')
        .select('status, user_id')
        .or(
          `and(user_id.eq.${myId},friend_id.eq.${theirId}),and(user_id.eq.${theirId},friend_id.eq.${myId})`
        )
        .limit(2);
      if (error) {
        reportError(error, 'PublicProfilePage.Friendship_check_failed');
        return 'none';
      }
      if (!friendshipRows?.length) return 'none';
      if (friendshipRows.some((row) => row.status === 'accepted')) return 'friends';
      const pending = friendshipRows.find((row) => row.status === 'pending');
      if (pending) return pending.user_id === myId ? 'pending_sent' : 'pending_received';
      return 'none';
    },
    []
  );

  const loadDossier = useCallback(async (targetId: string): Promise<PublicProfile | null> => {
    const { data, error } = await supabase
      .from('profiles')
      .select(
        `id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url, bio, created_at, player_number, player_tags`
      )
      .eq('id', targetId)
      .limit(1);
    if (error) throw error;
    const row = data?.[0];
    if (!row) return null;
    return {
      id: row.id,
      handle: playerDisplayName(row, 'arena'),
      username: row.username || '',
      avatarUrl: row.avatar_url || '',
      bio: row.bio || '',
      createdAt: row.created_at,
      playerNumber: Number(row.player_number) || 0,
      tags: Array.isArray(row.player_tags) ? row.player_tags : [],
    };
  }, []);

  const loadRecord = useCallback(async (targetId: string): Promise<ArenaRecord | null> => {
    const { data, error } = await supabase
      .from('player_stats')
      .select('hands_played, vpip, pfr, tournaments_played, tournaments_won')
      .eq('user_id', targetId)
      .limit(100);
    if (error) {
      reportError(error, 'PublicProfilePage.record');
      return null;
    }
    if (!data || data.length === 0) return null;
    return aggregateArenaRecord(data);
  }, []);

  const loadProfile = useCallback(async () => {
    if (!userId || !user?.id) return;

    // Viewing your own dossier: the credential page is the richer surface.
    if (userId === user.id) {
      navigate('/profile', { replace: true });
      return;
    }

    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const [dossier, arenaRecord, mutuals, blocked, friendship, status] = await Promise.all([
        loadDossier(userId),
        loadRecord(userId),
        friendSuggestionService.getMutualFriends(user.id, userId),
        blockService.isBlocked(user.id, userId),
        checkFriendship(user.id, userId),
        playerStatusService.getPlayerStatus(userId),
      ]);

      if (!isMounted.current) return;
      setProfile(dossier);
      setRecord(arenaRecord);
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
  }, [checkFriendship, isMounted, loadDossier, loadRecord, navigate, toast, userId, user?.id]);

  useVisibilityRefresh(() => loadProfile());

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  // Bus listeners: real-time friend/block/status sync
  useEffect(() => {
    const unsubFriend = masterBus.subscribeDebounced(
      'FRIEND_REQUEST_ACCEPTED',
      () => {
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
        if (event.payload?.toUserId === userId) setFriendStatus('pending_sent');
      },
      300
    );
    const unsubBlock = masterBus.subscribeDebounced(
      'USER_BLOCKED',
      (event) => {
        if (event.payload?.blockedUserId === userId) setIsBlocked(true);
      },
      300
    );
    const unsubUnblock = masterBus.subscribeDebounced(
      'USER_UNBLOCKED',
      (event) => {
        if (event.payload?.unblockedUserId === userId) setIsBlocked(false);
      },
      300
    );
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
  }, [checkFriendship, userId, user?.id]);

  // ── Actions ──────────────────────────────────────────────────────────────

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
      toast.success('Friend request sent!');
    } catch (err) {
      reportError(err, 'PublicProfilePage.Add_friend_error');
      if (isMounted.current) toast.error('Failed to send friend request');
    }
    if (isMounted.current) setActionLoading(false);
  };

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
      toast.success('Friend request accepted!');
    } catch (err) {
      reportError(err, 'PublicProfilePage.Accept_friend_error');
      if (isMounted.current) toast.error('Failed to accept request');
    }
    if (isMounted.current) setActionLoading(false);
  };

  // The messenger owns "start or resume conversation"; compose deep-link only.
  const handleMessage = () => {
    if (!userId) return;
    navigate(`/messages?compose=${userId}`);
  };

  const handleBlockConfirm = async (reason?: string) => {
    if (!user?.id || !userId) return;
    const success = await blockService.blockUser(user.id, userId, reason);
    if (!isMounted.current) return;
    if (success) {
      setIsBlocked(true);
      setShowBlockModal(false);
      toast.success('Player blocked');
    } else {
      toast.error('Failed to block player');
    }
  };

  const handleUnblock = async () => {
    if (!user?.id || !userId) return;
    const success = await blockService.unblockUser(user.id, userId);
    if (!isMounted.current) return;
    if (success) {
      setIsBlocked(false);
      toast.success('Player unblocked');
    } else {
      toast.error('Failed to unblock player');
    }
  };

  const profileLink = useMemo(
    () => (userId ? playerStatusService.generateProfileLink(userId) : ''),
    [userId]
  );

  const handleShare = async () => {
    if (!profileLink || !profile) return;
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: `${profile.handle} On Smarter Poker`, url: profileLink });
        return;
      }
      await navigator.clipboard.writeText(profileLink);
      toast.success('Profile link copied!');
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      reportError(err, 'PublicProfilePage.share');
      toast.error('Could not copy the profile link');
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="public-profile-page">
        <div className="public-profile-loading" role="status">
          <PageSkeleton variant="default" />
          <p>Loading Profile...</p>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="public-profile-page">
        <div className="public-profile-empty" role="status">
          <span className="public-profile-eyebrow">Player Network // Dossier</span>
          <h2>Player Not Found</h2>
          <p>This Credential Is Not On File. The Link May Be Old Or The Account Closed.</p>
          <div className="public-profile-empty-actions">
            <button type="button" className="action-btn" onClick={() => navigate(-1)}>
              Go Back
            </button>
            <button type="button" className="action-btn" onClick={() => navigate('/players')}>
              Find Players
            </button>
          </div>
        </div>
      </div>
    );
  }

  const lastSeen = playerStatus?.lastSeen ? relativeTimeTitle(playerStatus.lastSeen) : null;
  const presence = playerStatus?.playingAt
    ? 'At A Table'
    : playerStatus?.isOnline
      ? 'Online'
      : lastSeen
        ? `Seen ${lastSeen}`
        : 'Offline';

  return (
    <article className="public-profile-page" aria-labelledby="public-profile-heading">
      {/* ── Dossier plate ─────────────────────────────────────────────── */}
      <header className="public-profile-header">
        <div className="public-profile-artwork" aria-hidden="true">
          <picture>
            <source
              media="(max-width: 760px)"
              srcSet={mediaUrl('images/profile/public-dossier-v1-768.webp')}
            />
            <img
              src={mediaUrl('images/profile/public-dossier-v1.webp')}
              alt=""
              width={1536}
              height={1024}
              decoding="async"
              fetchPriority="high"
            />
          </picture>
        </div>

        <div className="public-profile-top">
          <span className="public-profile-eyebrow">Player Network // Public Dossier</span>
          <span
            className={`public-profile-presence ${playerStatus?.isOnline || playerStatus?.playingAt ? 'is-live' : ''}`}
            role="status"
          >
            <span aria-hidden="true" />
            {presence}
          </span>
        </div>

        <div className="profile-hero">
          <div className="profile-medallion">
            <img
              src={profile.avatarUrl || generateDefaultAvatar()}
              alt={`${profile.handle} Avatar`}
              width={132}
              height={132}
              decoding="async"
              fetchPriority="high"
              onError={(e) => {
                (e.target as HTMLImageElement).src = generateDefaultAvatar();
              }}
            />
          </div>
          <h1 id="public-profile-heading" className="profile-username">
            {profile.handle}
          </h1>
          <div className="profile-badges">
            {profile.playerNumber > 0 && <span>Player #{profile.playerNumber}</span>}
            <span>Member Since {formatMemberSince(profile.createdAt)}</span>
            {record && record.clubs > 0 && (
              <span>
                {formatCount(record.clubs)} {record.clubs === 1 ? 'Club' : 'Clubs'}
              </span>
            )}
          </div>
          {profile.bio && <p className="profile-bio">{profile.bio}</p>}
          {profile.tags.length > 0 && (
            <ul className="profile-tags" aria-label="Player Tags">
              {profile.tags.map((tag) => (
                <li key={tag}>{tag}</li>
              ))}
            </ul>
          )}

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

        {/* Arena record: public by policy, aggregated across clubs */}
        <dl className="public-profile-record" aria-label="Arena Record">
          <div>
            <dt>Hands</dt>
            <dd>{record ? formatCount(record.hands) : '-'}</dd>
          </div>
          <div>
            <dt>VPIP / PFR</dt>
            <dd>
              {record && record.hands > 0
                ? `${formatPct(record.vpip, 0)} / ${formatPct(record.pfr, 0)}`
                : '-'}
            </dd>
          </div>
          <div>
            <dt>Tourneys</dt>
            <dd>{record ? formatCount(record.tournamentsPlayed) : '-'}</dd>
          </div>
          <div>
            <dt>Titles</dt>
            <dd>{record ? formatCount(record.tournamentsWon) : '-'}</dd>
          </div>
        </dl>
      </header>

      {/* ── Actions console ──────────────────────────────────────────── */}
      <nav className="profile-actions" aria-label="Player Actions">
        {isBlocked ? (
          <button
            type="button"
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
                type="button"
                className="action-btn add-friend-btn"
                onClick={handleAddFriend}
                disabled={actionLoading}
              >
                Add Friend
              </button>
            )}
            {friendStatus === 'pending_sent' && (
              <button type="button" className="action-btn pending-btn" disabled>
                Request Sent
              </button>
            )}
            {friendStatus === 'pending_received' && (
              <button
                type="button"
                className="action-btn accept-btn"
                onClick={handleAcceptFriend}
                disabled={actionLoading}
              >
                Accept Request
              </button>
            )}
            {friendStatus === 'friends' && (
              <button type="button" className="action-btn friends-btn" disabled>
                Friends
              </button>
            )}
            <button
              type="button"
              className="action-btn message-btn"
              onClick={handleMessage}
              disabled={actionLoading}
            >
              Message
            </button>
            <button
              type="button"
              className="action-btn block-btn"
              onClick={() => setShowBlockModal(true)}
              aria-label={`Block ${profile.handle}`}
            >
              Block
            </button>
          </>
        )}
        {/* Report stays available while blocked: staff review needs the
            report regardless of whether the reporter still sees the player. */}
        <button
          type="button"
          className="action-btn report-btn"
          onClick={() => navigate(`/report/${userId}`)}
          aria-label={`Report ${profile.handle}`}
        >
          Report
        </button>
        <button type="button" className="action-btn share-btn" onClick={handleShare}>
          Share
        </button>
      </nav>

      {/* ── Mutual friends ───────────────────────────────────────────── */}
      {mutualFriends.length > 0 && (
        <section className="mutual-friends-section" aria-labelledby="mutual-heading">
          <h3 id="mutual-heading">
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
                  alt=""
                  className="mutual-avatar"
                  loading="lazy"
                  decoding="async"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = generateDefaultAvatar();
                  }}
                />
                <span>{friend.username}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* ── QR: drawn locally, nothing leaves the browser ───────────── */}
      {userId && profileLink && (
        <section className="profile-qr-section" aria-labelledby="qr-heading">
          <h3 id="qr-heading">Scan To Connect</h3>
          <div className="profile-qr-frame">
            <Suspense fallback={<div className="profile-qr-loading" aria-hidden="true" />}>
              <LazyQRCode
                value={profileLink}
                size={168}
                bgColor="#05070a"
                fgColor="#e6f7ff"
                level="M"
                marginSize={2}
                title={`${profile.handle} Profile Link`}
              />
            </Suspense>
          </div>
          <p className="qr-hint">Scan At The Table To Add As Friend</p>
        </section>
      )}

      {showBlockModal && (
        <PlayerBlockModal
          playerName={profile.handle}
          onConfirm={handleBlockConfirm}
          onCancel={() => setShowBlockModal(false)}
        />
      )}
    </article>
  );
}
