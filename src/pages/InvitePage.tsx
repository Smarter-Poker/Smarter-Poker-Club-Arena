/**
 * 📨 INVITE PAGE — Club Invitation
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { sizedStorageUrl } from '../utils/avatarGenerator';
import { useAuthUser } from '../hooks/useAuthUser';
import { ClubsService } from '../services/ClubsService';
import { useToast } from '../components/common/Toast';
import { masterBus } from '../core/MasterBus';
import './InvitePage.css';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubIdFilter } from '../utils/clubIdResolver';
import PageSkeleton from '../components/common/PageSkeleton';
import ClubBottomNav from '../components/club/ClubBottomNav';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { reportError } from '../utils/errorReporter';
import { MEDIA_BASE } from '../utils/mediaBase';

import { safeErrorMessage } from '../utils/safeErrorMessage';
const inviteStepAnimationStyle = {
  opacity: 0,
  transform: 'translateY(12px)',
  animation: 'animationsFadeInUp 0.6s ease-out forwards',
};

interface ClubInfo {
  id: string;
  club_id?: string | number;
  slug?: string;
  name: string;
  description?: string;
  member_count: number;
  avatar_url?: string;
  logo_url?: string;
  is_public: boolean;
}

export default function InvitePage() {
  const navigate = useNavigate();
  const { clubId } = useParams();
  const [searchParams] = useSearchParams();
  const inviteCode = searchParams.get('code');
  const refCode = searchParams.get('ref');
  const { user } = useAuthUser();

  const [club, setClub] = useState<ClubInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadyMember, setAlreadyMember] = useState(false);
  const [pendingApproval, setPendingApproval] = useState(false);
  const [inviteUrl, setInviteUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toast = useToast();

  const loadClubInfo = useCallback(
    async (getIsMounted?: () => boolean) => {
      if (!getIsMounted || getIsMounted()) {
        setLoading(true);
        setError(null);
      }
      try {
        let clubQuery = supabase
          .from('clubs')
          .select(
            'id, club_id, slug, name, description, member_count, avatar_url, logo_url, is_public'
          );

        if (inviteCode) {
          clubQuery = clubQuery.eq('invite_code', inviteCode);
        } else if (clubId) {
          const { column, value } = resolveClubIdFilter(clubId);
          clubQuery = clubQuery.eq(column, value);
        } else {
          if (!getIsMounted || getIsMounted()) {
            setError('Invalid invitation link');
            setLoading(false);
          }
          return;
        }

        const { data: clubData, error: clubError } = await clubQuery.maybeSingle();

        if (getIsMounted && !getIsMounted()) return;
        if (clubError || !clubData) {
          setError('Club not found or invitation expired');
          setLoading(false);
          return;
        }

        setClub({
          id: clubData.id,
          club_id: clubData.club_id,
          name: clubData.name,
          description: clubData.description,
          member_count: clubData.member_count || 0,
          avatar_url: clubData.avatar_url,
          logo_url: clubData.logo_url,
          is_public: clubData.is_public,
        });

        if (user?.id) {
          const { data: membership } = await supabase
            .from('club_members')
            .select('user_id, status')
            .eq('club_id', clubData.id)
            .eq('user_id', user.id)
            .maybeSingle();

          if (getIsMounted && !getIsMounted()) return;
          // A 'pending' row is a queued approval request, NOT full membership —
          // show the "awaiting approval" state instead of "you're a member".
          if (membership?.status === 'pending') {
            setPendingApproval(true);
            setAlreadyMember(false);
          } else {
            setPendingApproval(false);
            setAlreadyMember(!!membership);
          }
        }
      } catch (err) {
        reportError(err, 'InvitePage.Failed_to_load_club');
        if (!getIsMounted || getIsMounted()) {
          toast.error('Failed to load club information');
          setError('Failed to load club information');
        }
      }
      if (!getIsMounted || getIsMounted()) setLoading(false);
    },
    [clubId, inviteCode, user?.id, toast]
  );

  useVisibilityRefresh(() => loadClubInfo());

  useEffect(() => {
    let isMounted = true;
    loadClubInfo(() => isMounted);

    const unsubJoined = masterBus.subscribeDebounced(
      'CLUB_JOINED',
      () => loadClubInfo(() => isMounted),
      500
    );
    const unsubUpdated = masterBus.subscribeDebounced(
      'CLUB_UPDATED',
      () => loadClubInfo(() => isMounted),
      1000
    );
    return () => {
      isMounted = false;
      unsubJoined();
      unsubUpdated();
    };
  }, [loadClubInfo]);

  // Store referral code if present
  useEffect(() => {
    if (club?.id && refCode) {
      window.localStorage.setItem(`referral_${club.id}`, refCode);
    }
  }, [club?.id, refCode]);

  // Generate invite URL and simple QR code when club loads
  useEffect(() => {
    if (club?.id) {
      const baseUrl = `${window.location.origin}/hub/club-arena/invite/${club.slug || club.id}`;
      if (user?.id) {
        supabase
          .from('profiles')
          .select('player_number')
          .eq('id', user.id)
          .single()
          .then(({ data }) => {
            const r = data?.player_number || user.id;
            setInviteUrl(`${baseUrl}?ref=${r}`);
          });
      } else {
        setInviteUrl(refCode ? `${baseUrl}?ref=${refCode}` : baseUrl);
      }
    }
  }, [club?.id, club?.slug, refCode, user?.id, alreadyMember]);

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      toast.success('Invite link copied!');
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      reportError(e, 'InvitePage.setTimeout');
      toast.error('Failed to copy link');
    }
  };

  const handleJoin = async () => {
    if (!club || !user?.id) return;

    setJoining(true);
    setError(null);
    try {
      // Route the join through fn_join_club (via ClubsService). The RPC decides
      // status from clubs.requires_approval: an approval-gated club yields a
      // 'pending' request, a public club yields an active membership. It also
      // emits CLUB_JOINED. We must NOT fake "Welcome!"/navigate-in/count-bump
      // for a pending request — the user is not a member until approved.
      const membership = await ClubsService.join(club.id);

      if (membership?.status === 'pending') {
        setPendingApproval(true);
        toast.success('Request submitted - pending owner approval.');
        setJoining(false);
        return;
      }

      // Active membership — bump the denormalized member count and enter.
      const { error: countErr } = await retryAsync(
        () =>
          // Round 19: prod sig (p_club_id, p_delta).
          supabase.rpc('increment_member_count', {
            p_club_id: club.id,
            p_delta: 1,
          }),
        3
      );
      if (countErr) {
        reportError(countErr, 'InvitePage.increment_member_count_failed');
        toast.error('Joined successfully, but member count may be temporarily off.');
      }

      toast.success(`Welcome to ${club.name}!`);
      navigate(`/clubs/${club.slug || club.id}`);
    } catch (err: any) {
      reportError(err, 'InvitePage.Failed_to_join');
      toast.error(err.message || 'Failed to join club');
      setError(safeErrorMessage(err, 'Failed to join club'));
    }
    setJoining(false);
  };

  if (loading) {
    return (
      <div className="invite-page">
        <div className="loading-state">
          <PageSkeleton variant="default" />
        </div>
      </div>
    );
  }

  if (error || !club) {
    return (
      <div className="invite-page">
        <div className="error-state">
          <span className="error-icon"></span>
          <h2>Oops!</h2>
          <p>{error || 'Invalid invitation'}</p>
          <button className="btn btn-primary" onClick={() => navigate('/clubs')}>
            Browse Clubs
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="invite-page">
      <div className="invite-card" style={inviteStepAnimationStyle}>
        <div className="club-avatar">
          {club.logo_url || club.avatar_url ? (
            <img
              src={sizedStorageUrl(club.logo_url || club.avatar_url || '', 96)}
              alt={club.name}
              loading="lazy"
              onError={(e) => {
                const target = e.target as HTMLImageElement;
                target.onerror = null; // prevent loop
                if (club.name?.toUpperCase().includes('SHARK')) {
                  target.src = `${MEDIA_BASE}images/shark-club-logo.jpg`;
                } else {
                  target.style.display = 'none';
                  if (target.parentElement) {
                    const span = document.createElement('span');
                    span.innerText = club.name?.[0]?.toUpperCase() || '?';
                    target.parentElement.appendChild(span);
                  }
                }
              }}
            />
          ) : club.name?.toUpperCase().includes('SHARK') ? (
            <img src={`${MEDIA_BASE}images/shark-club-logo.jpg`} alt={club.name} loading="lazy" />
          ) : (
            <span>{club.name?.[0]?.toUpperCase() || '?'}</span>
          )}
        </div>

        <h1 className="club-name">{club.name}</h1>

        {club.description && <p className="club-description">{club.description}</p>}

        <div className="club-stats">
          <div className="stat">
            <span className="stat-value">{club.member_count}</span>
            <span className="stat-label">Members</span>
          </div>
        </div>

        <p className="invite-message">
          YOU'VE BEEN INVITED...
          <br />
          TO JOIN THIS POKER CLUB
        </p>

        {pendingApproval ? (
          <div className="already-member">
            <span>Request Submitted - Pending Approval.</span>
            <p style={{ color: '#aaa', fontSize: '0.85rem', margin: '8px 0 12px' }}>
              This Club Requires Owner Approval. You'll Gain Access Once Your Request Is Reviewed.
            </p>
            <button className="btn btn-primary" onClick={() => navigate('/clubs')}>
              Browse Clubs
            </button>
          </div>
        ) : alreadyMember ? (
          <>
            <div className="already-member">
              <span>You're Already A Member!</span>
              <button
                className="btn btn-primary"
                onClick={() => navigate(`/clubs/${club.slug || club.id}`)}
              >
                Enter Club
              </button>
            </div>

            {/* Shareable Invite Section */}
            <div className="share-invite-panel">
              <h3 className="share-invite-title">Share Invite</h3>
              <div
                className="qr-code-wrapper"
                style={{
                  margin: '0 auto 16px',
                  display: 'flex',
                  justifyContent: 'center',
                  cursor: 'pointer',
                }}
                onClick={handleCopyLink}
                title="Click to copy invite link"
              >
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(inviteUrl)}&color=00d4ff&bgcolor=0a0a14`}
                  alt="QR Code"
                  loading="lazy"
                  style={{
                    borderRadius: 8,
                    border: '1px solid rgba(0, 212, 255, 0.3)',
                    boxShadow: '0 0 15px rgba(0, 212, 255, 0.15)',
                  }}
                />
              </div>
              <div className="share-link-row">
                <input readOnly value={inviteUrl} className="share-link-input" />
                <button
                  onClick={handleCopyLink}
                  className={`share-copy-btn ${copied ? 'copied' : ''}`}
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
                {navigator.share && (
                  <button
                    onClick={() => {
                      navigator
                        .share({
                          title: `Join ${club.name}`,
                          text: `You've been invited to join ${club.name} on Club Arena!`,
                          url: inviteUrl,
                        })
                        .catch(() => {});
                    }}
                    className="share-copy-btn"
                    style={{ background: 'rgba(0, 212, 255, 0.2)', marginLeft: '6px' }}
                  >
                    Share
                  </button>
                )}
              </div>
            </div>
          </>
        ) : (
          <button className="btn btn-primary join-btn" onClick={handleJoin} disabled={joining}>
            {joining ? 'Joining...' : 'Join Club'}
          </button>
        )}
      </div>
      {clubId && <ClubBottomNav clubId={clubId} />}
    </div>
  );
}
