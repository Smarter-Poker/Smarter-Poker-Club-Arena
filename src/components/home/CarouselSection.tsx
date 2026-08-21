/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CAROUSEL SECTION — All club cards rendered as fully displayed featured cards
 * ═══════════════════════════════════════════════════════════════════════════════
 * Every club (Shark Club, Club JAQK, Midway Union, user-created clubs, etc.)
 * renders as a premium, clickable card with the metal-frame background and
 * live stats. Single-click navigates to the club's lobby.
 */

import { useState, useEffect, useRef, useCallback, Suspense, lazy } from 'react';
import { MEDIA_BASE } from '../../utils/mediaBase';
import haptic from '../../services/HapticService';
import PremiumSFX from '../../services/PremiumSFX';
import { STORAGE_KEYS } from '../../lib/storage';
import { SHARK_CLUB_ID } from '../../lib/constants';
import styles from '../../pages/HomePage.module.css';
import { PageErrorBoundary } from '../common/PageErrorBoundary';
import { Carousel } from '../carousel';
import type { ToastContextValue } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';

// Lazy-load heavy component

const ClubCardPanel = lazy(() => import('../club/ClubCardPanel'));

// ── Types ─────────────────────────────────────────
export interface UserClub {
  id: string;
  name?: string;
  club_id?: number | string;
  logo_url?: string;
  card_image_url?: string;
  member_count?: number;
  active_tables?: number;
  is_owner?: boolean;
  last_active_at?: string;
  entity_type?: 'club' | 'union';
  [key: string]: unknown;
}

export interface ClubStats {
  totalMembers: number;
  clubLevel: number;
  activePlayers: number;
}

export interface CarouselSectionProps {
  displayClubs: UserClub[];
  clubStats: Record<string, ClubStats>;
  pinnedClubIds: string[];
  /* Dan 2026-08-20: HomePage passes these three; the interface never declared
     them, so `tsc -b` failed on TS2322 and BLOCKED every Club Arena build
     (`npm run build` is `tsc -b && vite build`) — a landmine for whoever
     pushed the in-flight Shark Club carousel work first.

     Declared optional and unused rather than deleted from the call site: the
     Shark Club card is rendered by ClubCardPanel further down and these are
     the values it will want. Nothing here reads them yet, so this is a pure
     type widening with no runtime effect. */
  sharkClubId?: string | null;
  sharkClubStats?: {
    totalMembers: number | null;
    clubLevel: number | null;
    activePlayers: number | null;
  };
  toast?: ToastContextValue;
  navigate: (path: string) => void;
  handleContextMenu: (e: React.MouseEvent, club: UserClub) => void;
  handleLongPressStart: (club: UserClub, e: React.TouchEvent) => void;
  handleLongPressEnd: () => void;
  onOpenJoinModal: () => void;
  onOpenCreateModal: () => void;
}

export default function CarouselSection({
  displayClubs,
  clubStats,
  pinnedClubIds,
  navigate,
  handleContextMenu,
  handleLongPressStart,
  handleLongPressEnd,
  onOpenJoinModal,
  onOpenCreateModal,
}: CarouselSectionProps) {
  const carouselRef = useRef<HTMLDivElement>(null);

  // True only while the user is the one scrolling. Programmatic scrolls
  // (browser scroll restoration, future auto-centring) must not trigger the
  // snap haptic/SFX.
  const userScrollRef = useRef(false);

  /* The drag-to-reorder state that lived here is gone with the handlers that
     wrote it. Nothing set it once the carousel took over the gesture, so the
     two "is this card being dragged" classes below were permanently false:
     state that can only ever hold one value is worse than no state, because it
     reads as a live feature. */
  const [orderedClubs, setOrderedClubs] = useState<UserClub[]>(displayClubs);

  // Keep orderedClubs in sync with displayClubs (respecting saved order)
  useEffect(() => {
    try {
      const savedOrder: string[] = JSON.parse(
        localStorage.getItem(STORAGE_KEYS.CLUB_ORDER) || '[]'
      );
      if (savedOrder.length > 0) {
        const orderMap = new Map(savedOrder.map((id, idx) => [id, idx]));
        const sorted = [...displayClubs].sort((a, b) => {
          const aPinned = pinnedClubIds.includes(a.id) ? 1 : 0;
          const bPinned = pinnedClubIds.includes(b.id) ? 1 : 0;
          if (bPinned !== aPinned) return bPinned - aPinned;
          const aOrder = orderMap.get(a.id) ?? 999;
          const bOrder = orderMap.get(b.id) ?? 999;
          return aOrder - bOrder;
        });
        setOrderedClubs(sorted);
      } else {
        setOrderedClubs(displayClubs);
      }
    } catch (e) {
      reportError(e, 'CarouselSection.sort');
      setOrderedClubs(displayClubs);
    }
  }, [displayClubs, pinnedClubIds]);

  // Haptic + SFX when a scroll SNAP settles.
  //
  // Gated on a real user gesture. The scroll event does not distinguish user
  // scrolling from a programmatic one (the old mount-time auto-centring used
  // to trip this handler and play the snap sound on page load, with the user
  // having touched nothing). Feedback for "you snapped a card" must follow an
  // actual input, so the flag is set by the input events that can start a
  // scroll and cleared once the snap has been announced.
  useEffect(() => {
    const el = carouselRef.current;
    if (!el) return;
    let snapTimer: ReturnType<typeof setTimeout> | null = null;

    const markUser = () => {
      userScrollRef.current = true;
    };
    const handleScroll = () => {
      if (!userScrollRef.current) return;
      if (snapTimer) clearTimeout(snapTimer);
      snapTimer = setTimeout(() => {
        haptic.light();
        PremiumSFX.scrollSnap();
        userScrollRef.current = false;
      }, 150);
    };

    el.addEventListener('pointerdown', markUser, { passive: true });
    el.addEventListener('touchstart', markUser, { passive: true });
    el.addEventListener('wheel', markUser, { passive: true });
    el.addEventListener('keydown', markUser);
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      el.removeEventListener('pointerdown', markUser);
      el.removeEventListener('touchstart', markUser);
      el.removeEventListener('wheel', markUser);
      el.removeEventListener('keydown', markUser);
      el.removeEventListener('scroll', handleScroll);
      if (snapTimer) clearTimeout(snapTimer);
    };
  }, []);

  // Enhancement #8: Drag handlers

  const handleClubCardClick = useCallback(
    (club: UserClub) => {
      haptic.success();
      PremiumSFX.navigate();
      try {
        localStorage.setItem(STORAGE_KEYS.LAST_VISITED, club.id);
        localStorage.setItem(STORAGE_KEYS.LAST_CLUB, club.id);
      } catch {
        /* quota / private mode - navigation still works */
      }
      navigate(`/clubs/${club.id}`);
    },
    [navigate]
  );

  // Render a single user club card as a featured-style card — memoized to prevent
  // unnecessary re-creation on every render cycle
  const renderClubCard = useCallback(
    (club: UserClub) => {
      const stats = clubStats[club.id];

      return (
        <div
          className={styles.carouselCardFeatured}
          /* The carousel owns the click: it decides whether a gesture was a
             tap or a drag, and whether a tap on an off-centre card should open
             it or bring it to the middle. Handling onClick here as well would
             open a club the player was only swiping past. */
          onContextMenu={(e) => handleContextMenu(e, club)}
          onTouchStart={(e) => handleLongPressStart(club, e)}
          onTouchEnd={handleLongPressEnd}
          onTouchCancel={handleLongPressEnd}
          /* HTML5 drag-to-reorder is GONE from these cards, deliberately.
             Native dragstart fires within a few pixels of pointer movement, so
             it and a swipe are the same gesture and the browser hands it to
             DnD every time: the carousel Dan asked for would simply never
             move on desktop. The saved order is still honoured on load (see
             STORAGE_KEYS.CLUB_ORDER above) and pinning still floats a club to
             the front; only reordering BY DRAGGING is retired. */
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            e.currentTarget.style.setProperty('--x', `${e.clientX - rect.left}px`);
            e.currentTarget.style.setProperty('--y', `${e.clientY - rect.top}px`);
          }}
          role="button"
          aria-label={`${club.name || 'Club'} - Click to enter lobby`}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleClubCardClick(club);
            }
          }}
        >
          {pinnedClubIds.includes(club.id) && (
            <span className={styles.pinnedBadge} title="Pinned">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
              </svg>
            </span>
          )}
          <div className={styles.carouselFeaturedPedestal}></div>
          <Suspense fallback={<div className={styles.cardSkeleton} />}>
            <PageErrorBoundary pageName={club.name || 'Club Card'}>
              <ClubCardPanel
                clubName={club.name?.toUpperCase() || 'MY CLUB'}
                totalMembers={stats?.totalMembers ?? club.member_count ?? 0}
                clubLevel={stats?.clubLevel ?? 1}
                activePlayers={stats?.activePlayers ?? 0}
                clubId={club.club_id}
                cardImageUrl={
                  Number(club.club_id) === SHARK_CLUB_ID
                    ? `${MEDIA_BASE}images/shark-club-card.jpg`
                    : club.card_image_url
                }
                logoUrl={Number(club.club_id) === SHARK_CLUB_ID ? undefined : club.logo_url}
                entityType={club.entity_type || 'club'}
              />
            </PageErrorBoundary>
          </Suspense>
        </div>
      );
    },
    [
      clubStats,
      handleClubCardClick,
      handleContextMenu,
      handleLongPressStart,
      handleLongPressEnd,
      pinnedClubIds,
    ]
  );

  return (
    <div className={styles.clubCarousel} ref={carouselRef}>
      {orderedClubs.length === 0 && (
        <div
          className={styles.ctaCard}
          onClick={() => {
            haptic.light();
            PremiumSFX.ctaClick();
            onOpenJoinModal();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              haptic.light();
              PremiumSFX.ctaClick();
              onOpenJoinModal();
            }
          }}
          role="button"
          aria-label="Join a Club"
          tabIndex={0}
        >
          <div className={styles.ctaCardIcon}>+</div>
          <span className={styles.ctaCardLabel}>Join A Club</span>
          <span className={styles.ctaCardSub}>Enter A Club Code To Join An Existing Club</span>
        </div>
      )}

      {orderedClubs.length > 0 && (
        /* ENDLESS CAROUSEL (Dan 2026-08-21): "a user can join and be a part of
           unlimited amounts of clubs, but the display is limited... the same
           exact functionality that the World Hub page has, with the tiles
           swiping back and forth in an endless carousel."

           The strip used to be a native `overflow-x: auto` scroller with CSS
           scroll snapping. That has ends: reach the last club and it stops,
           and with a long list the only way back to the first is to drag all
           the way through every one of them. The carousel wraps, so the far
           end of the list is one swipe away in either direction, which is what
           makes it usable at "unlimited amounts of clubs".

           Interaction constants are lifted from the World Hub's own engine so
           the feel matches. See components/carousel/Carousel.tsx for what was
           portable from a WebGL carousel and what was not. */
        <Carousel
          items={orderedClubs}
          getKey={(club) => club.id}
          onSelect={(club) => handleClubCardClick(club)}
          ariaLabel="Your Clubs"
          renderItem={(club) => renderClubCard(club)}
        />
      )}

      {orderedClubs.length === 0 && (
        <div
          className={styles.ctaCard}
          onClick={() => {
            haptic.light();
            PremiumSFX.ctaClick();
            onOpenCreateModal();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              haptic.light();
              PremiumSFX.ctaClick();
              onOpenCreateModal();
            }
          }}
          role="button"
          aria-label="Create a Club"
          tabIndex={0}
        >
          <div className={styles.ctaCardIcon}>+</div>
          <span className={styles.ctaCardLabel}>Create Club</span>
          <span className={styles.ctaCardSub}>Start Your Own Poker Club And Invite Players</span>
        </div>
      )}
    </div>
  );
}
