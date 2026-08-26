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
import { SHARK_CLUB_ID } from '../lib/constants';

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
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
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

      // Draw a simple QR-like grid on canvas
      const canvas = qrCanvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const size = 160;
          canvas.width = size;
          canvas.height = size;
          ctx.fillStyle = '#0a0a14';
          ctx.fillRect(0, 0, size, size);

          // Draw subtle grid lines
          ctx.strokeStyle = 'rgba(0, 212, 255, 0.1)';
          ctx.lineWidth = 1;
          for (let i = 0; i < size; i += 8) {
            ctx.beginPath();
            ctx.moveTo(i, 0);
            ctx.lineTo(i, size);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0, i);
            ctx.lineTo(size, i);
            ctx.stroke();
          }

          // Generate deterministic pattern from club ID
          ctx.fillStyle = '#00d4ff';
          const cellSize = 8;
          const grid = size / cellSize;
          const seed = club.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);

          // Outer finder patterns
          ctx.fillRect(8, 8, 24, 24);
          ctx.clearRect(12, 12, 16, 16);
          ctx.fillRect(16, 16, 8, 8);

          ctx.fillRect(size - 32, 8, 24, 24);
          ctx.clearRect(size - 28, 12, 16, 16);
          ctx.fillRect(size - 24, 16, 8, 8);

          ctx.fillRect(8, size - 32, 24, 24);
          ctx.clearRect(12, size - 28, 16, 16);
          ctx.fillRect(16, size - 24, 8, 8);

          for (let x = 0; x < grid; x++) {
            for (let y = 0; y < grid; y++) {
              const hash = ((x * 31 + y * 17 + seed) * 7919) % 100;
              // Skip finder pattern areas
              if ((x < 5 && y < 5) || (x > grid - 6 && y < 5) || (x < 5 && y > grid - 6)) continue;

              if (hash < 45) {
                ctx.globalAlpha = hash % 3 === 0 ? 0.6 : 1; // Subtle opacity variance
                ctx.fillRect(x * cellSize, y * cellSize, cellSize - 1, cellSize - 1);
                ctx.globalAlpha = 1;
              }
            }
          }
        }
      }
    }
  }, [club?.id, club?.slug, refCode, user?.id]);

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
            />
          ) : Number(club.club_id) === SHARK_CLUB_ID ? (
            <img src={`${MEDIA_BASE}images/shark-club-logo.jpg`} alt={club.name} loading="lazy" />
          ) : (
            <span>{club.name[0]?.toUpperCase()}</span>
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
              <canvas
                ref={qrCanvasRef}
                onClick={handleCopyLink}
                style={{
                  display: 'block',
                  margin: '0 auto 12px',
                  width: 120,
                  height: 120,
                  borderRadius: 8,
                  cursor: 'pointer',
                  border: '1px solid rgba(0, 212, 255, 0.3)',
                  boxShadow: '0 0 15px rgba(0, 212, 255, 0.15)',
                }}
                title="Click to copy invite link"
              />
              <div className="share-link-row">
                <input readOnly value={inviteUrl} className="share-link-input" />
                <button
                  onClick={handleCopyLink}
                  className={`share-copy-btn ${copied ? 'copied' : ''}`}
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
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
