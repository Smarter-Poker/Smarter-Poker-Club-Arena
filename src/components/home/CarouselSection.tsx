/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CAROUSEL SECTION — All club cards rendered as fully displayed featured cards
 * ═══════════════════════════════════════════════════════════════════════════════
 * Every club (Shark Club, Club JAQK, Midway Union, user-created clubs, etc.)
 * renders as a premium, clickable card with the metal-frame background and
 * live stats. Single-click navigates to the club's lobby.
 */

import { useState, useEffect, useCallback, useMemo, Suspense } from 'react';
import { MEDIA_BASE } from '../../utils/mediaBase';
import haptic from '../../services/HapticService';
import { playPremiumSfx } from '../../utils/playPremiumSfx';
import { STORAGE_KEYS } from '../../lib/storage';
import { SHARK_CLUB_ID } from '../../lib/constants';
import { initialArenaIndex, orderArenaCards } from './arenaSelection';
import styles from '../../pages/HomePage.module.css';
import { PageErrorBoundary } from '../common/PageErrorBoundary';
import { Carousel } from '../carousel';
import { preloadClubLobby } from '../../utils/ChunkPreloader';
import type { ToastContextValue } from '../common/Toast';
import { reportError } from '../../utils/errorReporter';
import { lazyWithRetry } from '../../utils/lazyWithRetry';

// Lazy-load heavy component

const ClubCardPanel = lazyWithRetry(() => import('../club/ClubCardPanel'));
const DiamondArenaCard = lazyWithRetry(() => import('../club/DiamondArenaCard'));

// ── Types ─────────────────────────────────────────
export interface UserClub {
  id: string;
  slug?: string;
  name?: string;
  club_id?: number | string;
  logo_url?: string;
  card_image_url?: string;
  member_count?: number;
  active_tables?: number;
  is_owner?: boolean;
  last_active_at?: string;
  entity_type?: 'club' | 'union';
  /** Automatic platform entry, not a mutable chip-club membership. */
  automatic_entry?: boolean;
  [key: string]: unknown;
}

export interface ClubStats {
  totalMembers: number | null;
  clubLevel: number | null;
  /** Distinct players holding a live seat anywhere on the club's floor. */
  activePlayers: number | null;
  /** Of those, distinct players at cash tables. */
  activeCash?: number | null;
  /** Of those, distinct players in tournaments, Spins and SNGs. */
  activeEvents?: number | null;
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
  /* The drag-to-reorder state that lived here is gone with the handlers that
     wrote it. Nothing set it once the carousel took over the gesture, so the
     two "is this card being dragged" classes below were permanently false:
     state that can only ever hold one value is worse than no state, because it
     reads as a live feature. */
  const orderedClubs = useMemo(() => {
    try {
      return orderArenaCards(
        displayClubs,
        pinnedClubIds,
        JSON.parse(localStorage.getItem(STORAGE_KEYS.CLUB_ORDER) || '[]')
      );
    } catch (error) {
      reportError(error, 'CarouselSection.sort');
      return orderArenaCards(displayClubs, pinnedClubIds, []);
    }
  }, [displayClubs, pinnedClubIds]);

  /* PHONE CARD WIDTH (Dan 2026-08-23: "THE MAIN CARD IS TOO BIG, CAN'T SEE THE
     CARDS TO THE LEFT OR RIGHT").

     Measured on a 390px viewport: the centre card came out 265px wide and the
     step between centres is 0.94 of that, so each neighbour had 52px showing —
     a sliver with no name and no stats on it, which reads as "there is only
     one club". The carousel's own default is `trackWidth * 0.55`, tuned on a
     desktop track where 55% still leaves room either side; on a phone the
     track IS the viewport, so 55% eats it.

     52% of the viewport capped at 210px puts the neighbours back at roughly a
     hundred pixels each — enough to show that they are club cards and to aim
     a thumb at. Desktop keeps the existing behaviour untouched: the override
     only applies under 480px. */
  const [phoneItemWidth, setPhoneItemWidth] = useState<number | undefined>(() =>
    typeof window !== 'undefined' && window.innerWidth <= 480
      ? Math.min(175, Math.round(window.innerWidth * 0.42))
      : undefined
  );
  useEffect(() => {
    const recompute = () =>
      setPhoneItemWidth(
        window.innerWidth <= 480 ? Math.min(175, Math.round(window.innerWidth * 0.42)) : undefined
      );
    window.addEventListener('resize', recompute);
    window.addEventListener('orientationchange', recompute);
    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('orientationchange', recompute);
    };
  }, []);

  /**
   * Snap feedback, from the carousel rather than from a scroll event.
   *
   * This used to listen for 'scroll' on the strip and fire once it went quiet.
   * The strip is no longer a scroll container (the carousel positions its
   * cards absolutely and moves them by transform), so that listener could
   * never fire again and the haptic and the snap sound were silently dead.
   * onIndexChange is the honest signal: it fires when a card has actually
   * landed in the middle, and never on mount.
   */
  const getClubKey = useCallback((club: UserClub) => club.id, []);

  const handleIndexChange = useCallback(() => {
    haptic.light();
    playPremiumSfx('scrollSnap');
    /* Warm the club lobby while the player is still deciding. It is the
       heaviest screen in the app and it is where every tap on this carousel
       goes, so fetching it at the moment a card settles turns the tap from
       "wait for a chunk" into an immediate navigation. Idempotent and
       failure-silent. */
    preloadClubLobby();
  }, []);

  /**
   * Open on the club the player last used, not always the first one.
   *
   * LAST_CLUB is already written on every club visit (see clubQuickLink), and
   * with an endless strip and "unlimited amounts of clubs" the difference
   * between landing on your club and landing on somebody else's is several
   * swipes, every single time you come back to this page.
   *
   * Falls back to 0 for a first visit, a cleared store, or a club that has
   * since been left. Computed once per club list rather than per render so it
   * cannot fight the player's own position mid-session.
   */
  const initialIndex = useMemo(() => {
    try {
      return initialArenaIndex(orderedClubs, localStorage.getItem(STORAGE_KEYS.LAST_CLUB));
    } catch {
      return initialArenaIndex(orderedClubs, null);
    }
  }, [orderedClubs]);

  // Enhancement #8: Drag handlers

  const handleClubCardClick = useCallback(
    (club: UserClub) => {
      haptic.success();
      playPremiumSfx('navigate');
      try {
        localStorage.setItem(STORAGE_KEYS.LAST_VISITED, club.id);
        localStorage.setItem(STORAGE_KEYS.LAST_CLUB, club.id);
      } catch {
        /* quota / private mode - navigation still works */
      }
      navigate(`/clubs/${club.slug || club.id}`);
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
          onContextMenu={club.automatic_entry ? undefined : (e) => handleContextMenu(e, club)}
          onTouchStart={club.automatic_entry ? undefined : (e) => handleLongPressStart(club, e)}
          onTouchEnd={club.automatic_entry ? undefined : handleLongPressEnd}
          onTouchCancel={club.automatic_entry ? undefined : handleLongPressEnd}
          /* HTML5 drag-to-reorder is GONE from these cards, deliberately.
             Native dragstart fires within a few pixels of pointer movement, so
             it and a swipe are the same gesture and the browser hands it to
             DnD every time: the carousel Dan asked for would simply never
             move on desktop. The saved order is still honoured on load (see
             STORAGE_KEYS.CLUB_ORDER above) and pinning still floats a club to
             the front; only reordering BY DRAGGING is retired. */
          /* The cursor-follow handler that lived here is GONE (2026-08-28).
             It ran getBoundingClientRect() - a forced layout read - and two
             setProperty calls on EVERY mousemove across every club card, to
             publish `--x` and `--y`. Nothing in the entire codebase reads
             either variable: `grep -rn "var(--x)" src/` returns nothing. The
             spotlight those coordinates once fed was removed at some point and
             the feeder was left running, so this was pure cost - a reflow per
             pointer move, per card - buying a value no stylesheet consumes. */
          role="button"
          aria-label={`${club.name || 'Club'} - Click To Enter Lobby`}
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
              {club.automatic_entry ? (
                /* Dan 2026-09-09: the Diamond Arena rides the same card chassis
                   as every club, not a poster - active players and the next
                   freeroll countdown on the bottom rail. */
                <DiamondArenaCard activePlayers={stats?.activePlayers ?? null} />
              ) : (
                <ClubCardPanel
                  clubName={club.name?.toUpperCase() || 'MY CLUB'}
                  totalMembers={stats?.totalMembers ?? null}
                  clubLevel={stats?.clubLevel ?? null}
                  activePlayers={stats?.activePlayers ?? null}
                  activeCash={stats?.activeCash ?? null}
                  activeEvents={stats?.activeEvents ?? null}
                  clubId={club.club_id}
                  cardImageUrl={
                    Number(club.club_id) === SHARK_CLUB_ID
                      ? `${MEDIA_BASE}images/shark-club-card.jpg`
                      : club.card_image_url
                  }
                  logoUrl={Number(club.club_id) === SHARK_CLUB_ID ? undefined : club.logo_url}
                  entityType={club.entity_type || 'club'}
                />
              )}
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
    <div className={styles.clubCarousel}>
      {orderedClubs.length === 0 && (
        <div
          className={styles.ctaCard}
          onClick={() => {
            haptic.light();
            playPremiumSfx('ctaClick');
            onOpenJoinModal();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              haptic.light();
              playPremiumSfx('ctaClick');
              onOpenJoinModal();
            }
          }}
          role="button"
          aria-label="Join A Club"
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
          /* Stable identities. The carousel memoises each rendered card on
             (getKey, renderItem) so it does not re-render five heavy
             ClubCardPanels on every frame of a drag; inline arrows here would
             be new functions on every render and would defeat that entirely. */
          getKey={getClubKey}
          onSelect={handleClubCardClick}
          /* A swipe must not also trigger the card's press-and-hold menu. The
             context menu opens after 500ms of touch and a deliberate slow
             swipe is easily longer than that, so without this the menu appears
             mid-gesture and the swipe is lost. */
          onDragStart={handleLongPressEnd}
          onIndexChange={handleIndexChange}
          ariaLabel="Poker Arena Selection"
          itemNoun="Club"
          /* Dan 2026-08-21: "IT NEEDS TO DISPLAY 3 CARDS AT ONCE, AND SNAP TO
             CENTER ONE CARD AT A TIME. NOT ONLY DISPLAY ONE AT A TIME."

             The default sizing gave each card 55% of the track, which is a
             one-up rule - over half the width per card leaves no room for a
             neighbour beside the centre, so the strip read as a single card
             even though three were mounted and swiping worked.

             Three across, side by side rather than tucked under one another.

             Dan 2026-08-22: "IT SHOULD SHOW 1-3 CARDS ON THE PAGE, WITH THE
             CARD IN THE MIDDLE THE LARGEST."

             0.9 was too gentle to read as a hierarchy - a 10% difference seen
             across a gap is invisible, so the three looked like equals and
             nothing drew the eye to the middle. 0.8 is plainly a step down
             while still leaving the neighbours' names and stats legible.

             Spacing drops to 0.94 to match: the neighbours are narrower now,
             so full spacing would open a gap where the shrink already made
             one. 0.94 stays above (1 + 0.8) / 2 = 0.9, the point below which a
             neighbour would start to overlap the centre card. */
          visibleCards={3}
          /* undefined on desktop, so the carousel's own sizing still applies. */
          itemWidth={phoneItemWidth}
          spacingRatio={0.94}
          edgeScale={0.8}
          initialIndex={initialIndex}
          renderItem={renderClubCard}
        />
      )}

      {orderedClubs.length === 0 && (
        <div
          className={styles.ctaCard}
          onClick={() => {
            haptic.light();
            playPremiumSfx('ctaClick');
            onOpenCreateModal();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              haptic.light();
              playPremiumSfx('ctaClick');
              onOpenCreateModal();
            }
          }}
          role="button"
          aria-label="Create A Club"
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
