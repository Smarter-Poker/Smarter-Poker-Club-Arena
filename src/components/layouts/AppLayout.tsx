/**
 *  CLUB ENGINE — App Layout
 * Main shell layout with navigation
 * ═══════════════════════════════════════════════════════════════════════════════
 * GLOBAL COMPONENTS WIRED:
 * - GlobalHeader: Hamburger, Back, Hub and the navigation orbs
 * - NotificationDropdown: Real-time notification center in header
 * - ClubAnnouncementBanner: Important announcements at top of content
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { Outlet, useLocation } from 'react-router-dom';
import RouteErrorBoundary from '../common/RouteErrorBoundary';
import { useEffect, useRef } from 'react';
import styles from './AppLayout.module.css';
import ClubArenaWelcomeModal, { useClubArenaWelcome } from '../modals/ClubArenaWelcomeModal';
import ClubAnnouncementBanner from '../club/ClubAnnouncementBanner';
import GlobalHeader from '../navigation/GlobalHeader';
import ArenaSectionRail from '../navigation/ArenaSectionRail';
import ClubOperationsRail from '../navigation/ClubOperationsRail';
import { useAuthUser } from '../../hooks/useAuthUser';
import CompleteProfileModal, { useCompleteProfile } from '../modals/CompleteProfileModal';
import { ClubWorkspaceProvider } from '../../contexts/ClubWorkspaceContext';
import NavigationTelemetry from '../navigation/NavigationTelemetry';

/*
 * THE ROUTE ART IS GONE (2026-08-30).
 *
 * A six-entry ROUTE_ART map, a `getCasinoZone(pathname)` classifier and a
 * `--casino-route-art` custom property used to run on every navigation to pick
 * a club / wallet / tile PNG for `.casinoStage::before`, which washed it across
 * the page at 0.28 opacity. Dan, with a screenshot: "YOU CAN SEE SOME OLD
 * BORDER IMAGES ON THE SIDES. THE WHOLE BACKGROUND SHOULD BE SOLID BLACK AND
 * ALL THE SAME COLOR." The pseudo-element that consumed the property was
 * deleted from AppLayout.module.css earlier the same day.
 *
 * All of it is deleted here rather than left running into nothing: a
 * classifier that computes an answer nobody reads is a trap for the next
 * reader, who has to prove it is dead before touching anything near it. The
 * stylesheet keeps the note describing what a themed stage would need if one
 * ever comes back. No asset was removed - bg-vault.jpg alone still has eight
 * other consumers.
 */

function AppLayoutContent() {
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  // User store for conditional rendering
  const { user } = useAuthUser();
  const { showWelcome, isReady, acceptWelcome } = useClubArenaWelcome();
  const {
    showProfileModal,
    isReady: profileReady,
    profileStatus,
    finishProfile,
  } = useCompleteProfile(user);

  // Hide global header on table and tournament play pages
  const isTablePage =
    location.pathname.startsWith('/table') ||
    (location.pathname.startsWith('/tournaments/') && location.pathname.endsWith('/play'));
  const showGlobalHeader = !isTablePage;

  /**
   * Full-bleed routes: pages that render their own edge-to-edge chrome and
   * must sit flush against the global header rather than inside the shell's
   * gutter. Dan, 2026-08-27, on notifications: "IT NEEDS TO BE RAISED UP TO
   * THE TOP TO BE ATTACHED TO THE GLOBAL HEADER."
   */
  const normalizedPath = location.pathname.replace(/\/+$/, '');
  const isClubLobbyPage = /^\/clubs\/[^/]+(?:\/lobby)?$/.test(normalizedPath);
  const isFlushPage = normalizedPath.endsWith('/notifications') || isClubLobbyPage;

  // Daily, Weekly, and Monthly Challenges are tabs within one accessible
  // page, even though each cycle has a bookmarkable URL. Their roving-tab
  // handler owns focus while switching cycles; treating that URL update as a
  // whole-page navigation schedules a later focus on <main> and steals focus
  // from the newly selected tab. Collapse only those three known subroutes to
  // one shell focus key. Entering or leaving Challenges still focuses main.
  const focusRouteKey = /^\/challenges\/(?:daily|weekly|monthly)$/.test(normalizedPath)
    ? '/challenges'
    : normalizedPath;

  // SPA navigation does not move browser focus by itself. Put keyboard and
  // screen-reader users at the start of the new page without changing scroll.
  useEffect(() => {
    const frame = requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [focusRouteKey]);

  return (
    <div className={styles.layout} data-profile-gate-status={profileStatus}>
      {/* First-time Welcome Modal */}
      {isReady && <ClubArenaWelcomeModal isOpen={showWelcome} onAccept={acceptWelcome} />}

      {/* Force Poker Alias Selection for Google Auth users */}
      {profileReady && (
        <CompleteProfileModal isOpen={showProfileModal} onComplete={finishProfile} />
      )}

      {/* Global Header — Always visible except on active table pages.
          It carries Back and Hub on every page now, so there is no longer a
          depth to tell it about. */}
      {showGlobalHeader && <GlobalHeader />}

      {/* The persistent table action bar is fixed immediately below the
          responsive GlobalHeader. This zero-height flow slot expands only
          while that bar is present, so announcements, rails, and page content
          all begin below it without ever pushing the global header off y=0. */}
      {showGlobalHeader && <div className={styles.pinnedActionBarClearance} aria-hidden="true" />}

      {/* Global Announcement Banner (shows club announcements when in a club context) */}
      <ClubAnnouncementBanner />

      {/* Route-family navigation keeps global sibling pages reachable without
          reopening the hamburger or duplicating the exhaustive route registry. */}
      {showGlobalHeader && <ArenaSectionRail />}

      {/* Club staff pages share one permission-aware command rail. It renders
          only inside the operations route family and leaves the live lobby,
          table, tournament, and ordinary member pages untouched. */}
      {showGlobalHeader && <ClubOperationsRail />}

      {/* Main Content */}
      <main
        ref={mainRef}
        id="main-content"
        tabIndex={-1}
        className={
          isFlushPage
            ? `${styles.main} ${styles.mainFlush} ${styles.casinoStage}`
            : `${styles.main} ${styles.casinoStage}`
        }
      >
        <RouteErrorBoundary>
          <Outlet />
        </RouteErrorBoundary>
      </main>
    </div>
  );
}

export default function AppLayout() {
  return (
    <ClubWorkspaceProvider>
      <NavigationTelemetry />
      <AppLayoutContent />
    </ClubWorkspaceProvider>
  );
}
