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
import { useEffect, useRef, type CSSProperties } from 'react';
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

const ROUTE_ART = {
  club: '/hub/club-arena/assets/club-buttons/club/club-identity-template-bbj-finish-v1.png',
  tournament: '/hub/club-arena/assets/club-buttons/game-cards/mtt/desktop.png',
  finance: '/hub/club-arena/assets/club-buttons/wallets/desktop/wallet-diamonds-v1.webp',
  player: '/hub/club-arena/images/tiles/player-stats-v9.png',
  union: '/hub/club-arena/assets/club-buttons/wallets/desktop/wallet-union-bank-v1.webp',
  system: '/hub/club-arena/assets/club-buttons/lobby/lobby-command-chassis-v2.png',
} as const;

type CasinoZone = keyof typeof ROUTE_ART;
type CasinoStageStyle = CSSProperties & { '--casino-route-art': string };

function getCasinoZone(pathname: string): CasinoZone {
  if (/^\/clubs\//.test(pathname) || ['/admin', '/data', '/players'].includes(pathname)) {
    return 'club';
  }
  if (/^\/unions?/.test(pathname) || pathname.startsWith('/union-')) return 'union';
  if (/tournament|xmtt|hand-history|session-history|leaderboard/.test(pathname)) {
    return 'tournament';
  }
  if (
    /wallet|cashier|marketplace|vip|rakeback|promotion|bonus|transaction|achievement|challenge/.test(
      pathname
    )
  ) {
    return 'finance';
  }
  if (/profile|stats|friend|search|invite/.test(pathname)) return 'player';
  return 'system';
}

function AppLayoutContent() {
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  // User store for conditional rendering
  const { user } = useAuthUser();
  const { showWelcome, isReady, acceptWelcome } = useClubArenaWelcome();
  const { showProfileModal, isReady: profileReady, finishProfile } = useCompleteProfile(user);

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
  const isFlushPage = location.pathname.replace(/\/+$/, '').endsWith('/notifications');
  const casinoZone = getCasinoZone(location.pathname);
  const casinoStageStyle: CasinoStageStyle = {
    '--casino-route-art': `url("${ROUTE_ART[casinoZone]}")`,
  };

  // SPA navigation does not move browser focus by itself. Put keyboard and
  // screen-reader users at the start of the new page without changing scroll.
  useEffect(() => {
    const frame = requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [location.pathname]);

  return (
    <div className={styles.layout}>
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
        data-casino-zone={casinoZone}
        style={casinoStageStyle}
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
