/**
 * 📨 INVITE PAGE — Club Invitation
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { sizedStorageUrl } from '../utils/avatarGenerator';
import { useAuthUser } from '../hooks/useAuthUser';
import { ClubJoinService } from '../services/ClubJoinService';
import { useToast } from '../components/common/Toast';
import { masterBus } from '../core/MasterBus';
import './InvitePage.css';
import { resolveClubIdFilter } from '../utils/clubIdResolver';
import PageSkeleton from '../components/common/PageSkeleton';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { reportError } from '../utils/errorReporter';
import { MEDIA_BASE } from '../utils/mediaBase';

import { safeErrorMessage } from '../utils/safeErrorMessage';
const inviteStepAnimationStyle = {
  opacity: 0,
  transform: 'translateY(12px)',
  animation: 'animationsFadeInUp 0.6s ease-out forwards',
};

/**
 * Inline SVG, never emoji — house rule 5, and emoji break the SWC compiler.
 * `currentColor` so each one takes the gold or red from the CSS around it
 * rather than carrying a second copy of the palette.
 */
const MembersIcon = () => (
  <svg className="invite-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7.5 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM9 14c-3.3 0-6 1.8-6 4v2h12v-2c0-2.2-2.7-4-6-4Zm7.5 0c-.7 0-1.4.1-2 .2 1.2.9 2 2.2 2 3.8v2H22v-2c0-2.2-2.5-4-5.5-4Z" />
  </svg>
);

const ShieldCheckIcon = () => (
  <svg className="invite-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2 4 5v6.2c0 4.9 3.4 9.5 8 10.8 4.6-1.3 8-5.9 8-10.8V5l-8-3Zm-1.2 14L7 12.2l1.4-1.4 2.4 2.4 5-5L17.2 9l-6.4 7Z" />
  </svg>
);

const AlertIcon = () => (
  <svg className="invite-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2.6 1.2 21.4h21.6L12 2.6Zm.9 15.2h-1.8V16h1.8v1.8Zm0-3.4h-1.8V9.6h1.8v4.8Z" />
  </svg>
);

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
  const [pendingApproval, setPendingApproval] = useState(false);
  const toast = useToast();

  /**
   * Go into the club and leave nothing behind in history.
   *
   * Used by all three ways a viewer stops being a prospect: an existing member
   * landing here at all, a pending request that redeems on load, and a
   * successful Join. All three used to `navigate()` (a PUSH) from three places
   * with slightly different arguments; a push leaves the invite page on the
   * stack, so Back from the club lands here, the member check runs again and
   * throws them forward — a Back button that does nothing, which is worse than
   * one that goes somewhere unexpected.
   *
   * `setLoading(true)` holds the skeleton up for the frame between the decision
   * and the route change, so the invite copy never flashes at somebody who is
   * already in.
   */
  const enterClub = useCallback(
    (slugOrId: string) => {
      setLoading(true);
      navigate(`/clubs/${slugOrId}`, { replace: true });
    },
    [navigate]
  );

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
          // `code`, not `invite_code`. clubs has never had an invite_code
          // column, so this branch returned PostgREST 42703 and the catch below
          // reported it as "Club not found or invitation expired" - a database
          // error wearing a plausible business message, on a public route.
          clubQuery = clubQuery.eq('code', inviteCode);
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
          // slug was queried and then dropped here, so club.slug was always
          // undefined and every share link this page built pointed at the raw
          // UUID instead of the readable /invite/<slug>.
          slug: clubData.slug,
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
            // ...unless they arrived on an invite link, which is what admits
            // them. This page used to be a dead end for exactly the people it
            // exists for: a player who joined an approval-gated club (all of
            // them are) and whose redemption had not run — because it could
            // not, or because they closed the tab mid-flight — came back to
            // "Pending Approval" and a Browse Clubs button, with no way to
            // spend the code that was sitting in their own localStorage.
            const redeemed = refCode
              ? await ClubJoinService.join({
                  identifier: clubData.slug || String(clubData.club_id || clubData.id),
                  referralCode: refCode,
                })
              : null;
            if (getIsMounted && !getIsMounted()) return;

            if (redeemed?.success && redeemed.status && redeemed.status !== 'pending') {
              setPendingApproval(false);
              toast.success(`Welcome to ${clubData.name}!`);
              enterClub(clubData.slug || clubData.id);
              return;
            }

            setPendingApproval(true);
          } else if (membership) {
            /* ── A MEMBER NEVER SEES THIS PAGE (Dan 2026-08-28, item 4) ──────
               Verbatim: "IF YOU ARE ALREADY A MEMBER YOU SHOULD NEVER EVER EVER
               SEE THIS."

               There used to be an `alreadyMember` state that rendered a
               "You're Already A Member!" panel with an Enter Club button — a
               dead-end screen whose only purpose was to make the member press
               one more button to get where they were already entitled to be.
               Every path INTO this page for a member is an accident: a stale
               link someone re-sent, their own share link opened on their own
               phone, a bookmark. So we go straight in.

               `replace: true` is the important half. A push would leave the
               invite page in history, so Back from the club lands here and
               redirects forward again — the user is trapped and the Back button
               looks broken. Replacing means Back goes to wherever they were
               before the link. */
            setPendingApproval(false);
            enterClub(clubData.slug || clubData.id);
            return;
          } else {
            setPendingApproval(false);
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
    // `enterClub` was missing here and eslint was warning about it: the member
    // redirect below calls it, so a stale closure would have navigated with a
    // stale club. It is a useCallback on [navigate], so adding it costs nothing.
    [clubId, inviteCode, refCode, user?.id, toast, enterClub]
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

  /* ── THE SHARE PANEL LIVED HERE, AND IT IS GONE ──────────────────────────
     It rendered only inside the `alreadyMember` branch, and since 2026-08-28 a
     member is redirected into the club before this page paints — so the panel,
     the invite-URL effect that fed it (a `profiles` round trip on every load
     purely to build a `?ref=`), the clipboard handler and the `qrcode.react`
     import were all unreachable code. Deleted rather than left behind: dead
     code that still runs a query is worse than dead code.

     NOTHING WAS LOST, verified before deleting rather than assumed. A member
     can still get this club's invite link, with a `?ref=` of their own player
     number, from three places that do not require any role:
       - the share button in the club lobby header  (ClubHomePage.tsx)
       - "Share Club" on Club Settings, one tap from the bottom nav
       - the referral banner on the club Promotions page (ReferralModal)
     The QR CODE, however, existed only here — it was the sole `QRCodeSVG` in
     `src/`. Flagged to Dan; it belongs on one of the three surfaces above,
     not on a page a member is no longer allowed to reach. */

  const handleJoin = async () => {
    if (!club) return;
    if (!user?.id) {
      // AuthGuard should have sent them to login long before this, but a button
      // that silently does nothing is the worst possible answer if it ever does
      // happen — say so rather than looking broken.
      toast.error('Please Sign In To Join This Club.');
      return;
    }

    setJoining(true);
    setError(null);
    try {
      // Route lookup, membership, application, and invitation redemption
      // status from clubs.requires_approval: an approval-gated club yields a
      // 'pending' request, a public club yields an active membership. It also
      // emits CLUB_JOINED. We must NOT fake "Welcome!"/navigate-in/count-bump
      // for a pending request — the user is not a member until approved.
      //
      // ClubJoinService redeems the invite in the same transaction and returns
      // the membership AS IT STANDS AFTERWARDS, so a player who arrived
      // on someone's link reaches the branch below already 'active'. Reading
      // the pre-redemption row here is precisely the bug that made invite links
      // dead ends.
      const joinResult = await ClubJoinService.join({
        identifier: club.slug || String(club.club_id || club.id),
        referralCode: refCode,
      });
      if (!joinResult.success) throw new Error(joinResult.error || 'Failed to join club');

      if (joinResult.status === 'pending') {
        setPendingApproval(true);
        toast.success('Request submitted - pending owner approval.');
        setJoining(false);
        return;
      }

      // NO manual member_count bump here. trg_sync_club_member_count RECOUNTS
      // clubs.member_count on every club_members insert/update, so the join
      // above has already set the exact figure. The increment_member_count(+1)
      // call this replaced ran on top of that recount and inflated the count
      // by one on every invite-page join — the only join path that did.

      toast.success(`Welcome to ${club.name}!`);
      enterClub(club.slug || club.id);
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
        <div className="invite-frame">
          <div className="invite-card error-state" style={inviteStepAnimationStyle}>
            {/* No club to name, so the plaque says what the page IS. The logo
                slot keeps the card's proportions rather than leaving the frame
                top-heavy with a bare heading. */}
            <div className="club-avatar">
              <span aria-hidden="true">?</span>
            </div>

            <div className="invite-plaque">Club Invite</div>

            <hr className="invite-divider" />

            <div className="invite-alert">
              <AlertIcon />
            </div>

            <h2>
              This Invite
              <br />
              Did Not Work
            </h2>
            <p>{error || 'That Invitation Link Is Invalid Or Has Expired.'}</p>
            <button
              className="invite-btn invite-btn--primary"
              onClick={() => navigate('/clubs-list')}
            >
              Browse Clubs
            </button>
          </div>
        </div>
      </div>
    );
  }

  const logo = club.logo_url || club.avatar_url;
  const memberCount = club.member_count.toLocaleString('en-US');

  return (
    <div className="invite-page">
      {/* `.invite-frame` IS the brushed-steel bezel and its padding is the
          bezel's thickness; `.invite-card` is the black glass inside it. Two
          elements because one box cannot be both, and the frame's two
          pseudo-elements are the blue neon down the long edges. */}
      <div className="invite-frame">
        <div className="invite-card" style={inviteStepAnimationStyle}>
          <div className="club-avatar">
            {logo ? (
              <img src={sizedStorageUrl(logo, 208)} alt="" loading="lazy" />
            ) : club.name?.toUpperCase().includes('SHARK') ? (
              <img src={`${MEDIA_BASE}images/shark-club-logo.jpg`} alt="" loading="lazy" />
            ) : (
              <span aria-hidden="true">{club.name[0]?.toUpperCase()}</span>
            )}
          </div>

          <h1 className="club-name">{club.name}</h1>

          {club.description && <p className="club-description">{club.description}</p>}

          {/* A gold-bordered chip, as in Dan's reference. Singular/plural
              because "1 members" on a new club is the kind of detail that makes
              a product look unfinished. */}
          <p className="club-stats">
            <MembersIcon />
            <span className="stat-value">{memberCount}</span>
            <span>{club.member_count === 1 ? 'Member' : 'Members'}</span>
          </p>

          <hr className="invite-divider" />

          {/* The club's own name is picked out in gold inside the sentence,
              rather than repeated in the same silver as the words around it.

              "You Are", not "You've": `check-title-case` capitalises the first
              letter of EVERY word and an apostrophe starts a new one, so
              "You've" comes out of the fixer as "You&apos;Ve". That artifact is
              visible in Dan's own mockup ("Club'S Tables"). Writing round the
              contraction satisfies the rule and reads properly, instead of
              satisfying the rule and looking broken. */}
          <p className="invite-message">
            You Are Invited To Join <span className="invite-club">{club.name}</span>
          </p>
          <p className="invite-sub">
            {pendingApproval
              ? 'Your Request Is With The Club Owner.'
              : 'Join To Play At This Club’s Tables, Tournaments And Promotions.'}
          </p>

          {pendingApproval ? (
            <>
              <div className="invite-pending">
                <div className="invite-pending-head">
                  <ShieldCheckIcon />
                  Request Submitted
                </div>
                {/* No contraction here either - see the note on the headline. */}
                <p>
                  This Club Requires Owner Approval. Access Is Granted Once Your Request Is
                  Reviewed.
                </p>
              </div>
              <button
                className="invite-btn invite-btn--secondary"
                onClick={() => navigate('/clubs-list')}
              >
                Browse Other Clubs
              </button>
            </>
          ) : (
            <button
              className="invite-btn invite-btn--primary"
              onClick={handleJoin}
              disabled={joining}
            >
              {joining ? 'Joining…' : 'Join Club'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
