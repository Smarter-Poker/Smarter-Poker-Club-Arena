/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PUBLIC PROFILE PAGE — View Another Player's Profile
 * ═══════════════════════════════════════════════════════════════════════════════
 * Shows: arena avatar, poker alias, bio, VIP tier, level, player number,
 * mutual friends, and action buttons (Add Friend, Message, Block, Report,
 * Share). The name and the face are the ones the felt shows: alias and
 * library art, never a legal name or the social photo (playerDisplayName.ts,
 * arenaAvatarSeparation.test.ts).
 *
 * 2026-09-04 #SmarterCasinoRealism audit: the QR code is rendered locally
 * (qrcode.react, already a dependency) instead of by api.qrserver.com, which
 * put every profile URL through a third party and drew a blank on a phone
 * with no route to it. The share button reports a clipboard refusal instead
 * of celebrating one. The "Achievement Showcase" that read a field no profile
 * ever carried is gone.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useIsMounted } from '../hooks/useIsMounted';
import { useParams, useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { profileService } from '../services/ProfileService';
import type { UserProfile } from '../services/ProfileService';
import { friendSuggestionService } from '../services/FriendSuggestionService';
import { blockService } from '../services/BlockService';
import { playerStatusService } from '../services/PlayerStatusService';
import type { PlayerStatus } from '../services/PlayerStatusService';
import { useAuthUser } from '../hooks/useAuthUser';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useToast } from '../components/common/Toast';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { PlayerAvatar } from '../components/avatars/PlayerAvatar';
import PlayerBlockModal from '../components/social/PlayerBlockModal';
import styles from './PublicProfilePage.module.css';
import PageSkeleton from '../components/common/PageSkeleton';
import { generateDefaultAvatar } from '../utils/avatarGenerator';
import { reportError } from '../utils/errorReporter';
import { mediaUrl } from '../utils/mediaBase';
import { vipStatusLabel } from '../utils/vipStatus';
import { aggregateArenaRecord, type ArenaRecord } from '../utils/arenaRecord';
import { formatCount, formatPct } from '../utils/format';

/** Purpose-built hero for this route (public/images/account). */
const HERO_ART = mediaUrl('images/account/public-dossier-hero-v1.webp');

export default function PublicProfilePage() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const isMounted = useIsMounted();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  /* The public arena record. player_stats is readable by every signed-in
     player by policy ("Player stats are public"), one row per club; the
     dossier folds them into one line. Null until it answers, never zeroes. */
  const [record, setRecord] = useState<ArenaRecord | null>(null);
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
      const [profileData, mutuals, blocked, friendship, status, arenaRecord] = await Promise.all([
        profileService.getPublicProfile(userId),
        friendSuggestionService.getMutualFriends(user.id, userId),
        blockService.isBlocked(user.id, userId),
        checkFriendship(user.id, userId),
        playerStatusService.getPlayerStatus(userId),
        supabase
          .from('player_stats')
          .select('hands_played, vpip, pfr, tournaments_played, tournaments_won')
          .eq('user_id', userId)
          .limit(100)
          .then(({ data, error }) => {
            if (error) {
              reportError(error, 'PublicProfilePage.record');
              return null;
            }
            return data && data.length > 0 ? aggregateArenaRecord(data) : null;
          }),
      ]);

      if (!isMounted.current) return;
      setProfile(profileData);
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
    setActionLoading(true);
    const success = await blockService.unblockUser(user.id, userId);
    if (!isMounted.current) return;
    setActionLoading(false);
    if (success) {
      setIsBlocked(false);
      toast.success('Player unblocked');
    } else {
      toast.error('Failed to unblock player');
    }
  };

  /* The clipboard write is a promise that can be refused (no permission,
     insecure context, a WebView with no clipboard). The old handler fired the
     success toast before the promise settled, so a refused copy still said
     "Profile link copied!". */
  const handleShare = async () => {
    if (!userId) return;
    const link = playerStatusService.generateProfileLink(userId);
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: 'Smarter Poker Player', url: link });
        return;
      }
      await navigator.clipboard.writeText(link);
      toast.success('Profile link copied!');
    } catch (err) {
      // A cancelled share sheet is the player's choice, not a failure.
      if ((err as Error)?.name === 'AbortError') return;
      reportError(err, 'PublicProfilePage.Share_failed');
      toast.error('Could not copy the link. Scan the QR code instead.');
    }
  };

  if (loading) {
    return (
      <div className={styles.publicProfilePage}>
        <div className={styles.publicProfileLoading}>
          <PageSkeleton variant="default" />
          <p>Loading Profile...</p>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className={styles.publicProfilePage}>
        <div className={styles.publicProfileEmpty}>
          <span className={styles.emptyIcon} aria-hidden="true">
            ◉
          </span>
          <h2>Player Not Found</h2>
          <button type="button" className={styles.actionBtn} onClick={() => navigate('/search')}>
            Find Players
          </button>
        </div>
      </div>
    );
  }

  const memberSince = new Date(profile.createdAt).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
  const arenaName = profile.displayName || profile.username;
  const profileLink = userId ? playerStatusService.generateProfileLink(userId) : '';

  return (
    <article className={styles.publicProfilePage}>
      {/* Header with avatar & name */}
      <header className={styles.publicProfileHeader}>
        <div
          className={styles.publicProfileArtwork}
          style={{ backgroundImage: `url("${HERO_ART}")` }}
          aria-hidden="true"
        />
        <div className={styles.profileHero}>
          <span className={styles.publicProfileEyebrow}>Player Network // Public Credential</span>
          <PlayerAvatar
            src={profile.avatarUrl || generateDefaultAvatar()}
            name={arenaName}
            size="xl"
            showPresence={false}
            showLevelBadge={true}
            level={profile.level}
            showVipRing={false}
          />
          <h1 className={styles.profileUsername}>{arenaName}</h1>
          {profile.playerNumber && (
            <span className={styles.profileHandle}>Player #{profile.playerNumber}</span>
          )}
          {profile.bio && <p className={styles.profileBio}>{profile.bio}</p>}
          <div className={styles.profileBadges}>
            {/* VIP or Lifetime VIP. There is no tier ladder (utils/vipStatus). */}
            {profile.vipStatus && profile.vipStatus !== 'none' && (
              <span
                className={`${styles.vipBadge}${profile.vipStatus === 'lifetime' ? ` ${styles.vipBadge_Lifetime}` : ''}`}
              >
                {vipStatusLabel(profile.vipStatus)}
              </span>
            )}
            {/* profiles.level is 1 on every row; a "Level 1" badge said
                nothing. The club count is a real fact about the player. */}
            {record && record.clubs > 0 && (
              <span className={styles.levelBadge}>
                {formatCount(record.clubs)} {record.clubs === 1 ? 'Club' : 'Clubs'}
              </span>
            )}
            <span className={styles.memberSince}>Member Since {memberSince}</span>
          </div>

          <dl className={styles.publicProfileRecord} aria-label="Arena Record">
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

          {/* Q3: Playing-At & Status */}
          {playerStatus?.playingAt && playerStatus.playingAtTableId ? (
            <button
              type="button"
              className={styles.playingAtBadge}
              onClick={() => navigate(`/table/${playerStatus.playingAtTableId}`)}
            >
              <span className={styles.playingAtDot} aria-hidden="true" />
              Playing At <strong>{playerStatus.playingAt}</strong>
            </button>
          ) : playerStatus?.playingAt ? (
            <div className={`${styles.playingAtBadge} ${styles.playingAtBadge_Static}`}>
              <span className={styles.playingAtDot} aria-hidden="true" />
              Playing At <strong>{playerStatus.playingAt}</strong>
            </div>
          ) : null}
          {playerStatus?.statusText && (
            <p className={styles.playerStatusText}>{playerStatus.statusText}</p>
          )}
        </div>
      </header>

      {/* Action Buttons */}
      <div className={styles.profileActions} role="group" aria-label="Player Actions">
        {isBlocked ? (
          <button
            type="button"
            className={`${styles.actionBtn} ${styles.unblockBtn}`}
            onClick={handleUnblock}
            disabled={actionLoading}
          >
            {actionLoading ? 'Working...' : 'Unblock'}
          </button>
        ) : (
          <>
            {friendStatus === 'none' && (
              <button
                type="button"
                className={`${styles.actionBtn} ${styles.addFriendBtn}`}
                onClick={handleAddFriend}
                disabled={actionLoading}
              >
                Add Friend
              </button>
            )}
            {friendStatus === 'pending_sent' && (
              <button type="button" className={`${styles.actionBtn} ${styles.pendingBtn}`} disabled>
                Request Sent
              </button>
            )}
            {friendStatus === 'pending_received' && (
              <button
                type="button"
                className={`${styles.actionBtn} ${styles.acceptBtn}`}
                onClick={handleAcceptFriend}
                disabled={actionLoading}
              >
                ✓ Accept Request
              </button>
            )}
            {friendStatus === 'friends' && (
              <button type="button" className={`${styles.actionBtn} ${styles.friendsBtn}`} disabled>
                ✓ Friends
              </button>
            )}
            <button
              type="button"
              className={`${styles.actionBtn} ${styles.messageBtn}`}
              onClick={handleMessage}
              disabled={actionLoading}
            >
              Message
            </button>
            <button
              type="button"
              className={`${styles.actionBtn} ${styles.blockBtn}`}
              onClick={() => setShowBlockModal(true)}
              aria-label={`Block ${arenaName}`}
            >
              Block
            </button>
          </>
        )}
        {/*
          PHASE 7 — the review queue could never receive anything.
          ReportPlayerPage has always written to user_reports, and
          clubs/:clubId/reports has always read it, but nothing anywhere
          linked to the form: user_reports held ZERO rows. This is the
          missing half - staff could review reports no player could file.
          Report stays reachable while the player is BLOCKED too: staff
          review needs the report regardless of who can see whom.
        */}
        <button
          type="button"
          className={`${styles.actionBtn} ${styles.reportBtn}`}
          onClick={() => navigate(`/report/${userId}`)}
          aria-label={`Report ${arenaName}`}
        >
          Report
        </button>
        {/* No `share-btn` class: this page never styled one, and the bare global
            `.share-btn` in the hand-replayer is `position: absolute` - with that
            stylesheet loaded, Share left the grid and floated. `actionBtn` is
            its real styling. */}
        <button type="button" className={styles.actionBtn} onClick={handleShare}>
          Share
        </button>
      </div>

      {/* Mutual Friends */}
      {mutualFriends.length > 0 && (
        <section className={styles.mutualFriendsSection} aria-labelledby="mutual-friends-heading">
          <h3 id="mutual-friends-heading">
            {mutualFriends.length} Mutual Friend{mutualFriends.length !== 1 ? 's' : ''}
          </h3>
          <div className={styles.mutualFriendsList}>
            {mutualFriends.slice(0, 6).map((friend) => (
              <button
                type="button"
                key={friend.id}
                className={styles.mutualFriendChip}
                onClick={() => navigate(`/profile/${friend.id}`)}
              >
                <img
                  src={friend.avatarUrl || generateDefaultAvatar()}
                  alt=""
                  className={styles.mutualAvatar}
                  loading="lazy"
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

      {/* Q3: Profile QR Code, rendered locally. */}
      {profileLink && (
        <section className={styles.profileQrSection} aria-labelledby="profile-qr-heading">
          <h3 id="profile-qr-heading">Scan To Connect</h3>
          <div className={styles.profileQrImage} role="img" aria-label={`QR Code For ${arenaName}`}>
            <QRCodeSVG value={profileLink} size={160} level="M" marginSize={1} />
          </div>
          <p className={styles.qrHint}>Scan At The Table To Add As Friend</p>
        </section>
      )}

      {/* Block Modal */}
      {showBlockModal && (
        <PlayerBlockModal
          playerName={arenaName}
          onConfirm={handleBlockConfirm}
          onCancel={() => setShowBlockModal(false)}
        />
      )}
    </article>
  );
}
