/**
 *  CLUB ENGINE — App Layout
 * Main shell layout with navigation
 * ═══════════════════════════════════════════════════════════════════════════════
 * GLOBAL COMPONENTS WIRED:
 * - GlobalHeader: Contains HUB button and navigation icons
 * - NotificationDropdown: Real-time notification center in header
 * - ClubAnnouncementBanner: Important announcements at top of content
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { Outlet, useLocation } from 'react-router-dom';
import RouteErrorBoundary from '../common/RouteErrorBoundary';
import { useState, useEffect } from 'react';
import styles from './AppLayout.module.css';
import ClubArenaWelcomeModal, { useClubArenaWelcome } from '../modals/ClubArenaWelcomeModal';
import ClubAnnouncementBanner from '../club/ClubAnnouncementBanner';
import GlobalHeader from '../navigation/GlobalHeader';
import { useAuthUser } from '../../hooks/useAuthUser';
import { masterBus } from '../../core/MasterBus';
import CompleteProfileModal, { useCompleteProfile } from '../modals/CompleteProfileModal';

export default function AppLayout() {
  const location = useLocation();

  // Use state to ensure correct value after client-side hydration
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  // ── Offline / Online detection ──
  useEffect(() => {
    const handleOffline = () => setIsOffline(true);
    const handleOnline = () => {
      setIsOffline(false);
      masterBus.emit('CONNECTION_RESTORED', { timestamp: Date.now() });
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  // User store for conditional rendering
  const { user } = useAuthUser();
  const { showWelcome, isReady, acceptWelcome } = useClubArenaWelcome();
  const { showProfileModal, isReady: profileReady, finishProfile } = useCompleteProfile(user);

  // Hide global header on table and tournament play pages
  const isTablePage =
    location.pathname.startsWith('/table') ||
    (location.pathname.startsWith('/tournaments/') && location.pathname.endsWith('/play'));
  const showGlobalHeader = !isTablePage;

  return (
    <div className={styles.layout}>
      {/* First-time Welcome Modal */}
      {isReady && <ClubArenaWelcomeModal isOpen={showWelcome} onAccept={acceptWelcome} />}

      {/* Force Poker Alias Selection for Google Auth users */}
      {profileReady && (
        <CompleteProfileModal isOpen={showProfileModal} onComplete={finishProfile} />
      )}

      {/* Global Header — Always visible except on active table pages */}
      {/* Lobby (/) = pageDepth 1 (HUB button), Sub-pages = pageDepth 2 (Back button) */}
      {showGlobalHeader && <GlobalHeader pageDepth={location.pathname === '/' ? 1 : 2} />}

      {/* Global Announcement Banner (shows club announcements when in a club context) */}
      <ClubAnnouncementBanner />

      {/* Offline Banner */}
      {isOffline && (
        <div
          style={{
            background: 'linear-gradient(135deg, #b91c1c, #991b1b)',
            color: '#fff',
            textAlign: 'center',
            padding: '8px 16px',
            fontSize: '13px',
            fontWeight: 600,
            letterSpacing: '0.3px',
            zIndex: 9999,
          }}
        >
          ⚠ You are offline — changes will sync when connection is restored
        </div>
      )}

      {/* Main Content */}
      <main id="main-content" className={styles.main}>
        <RouteErrorBoundary>
          <Outlet />
        </RouteErrorBoundary>
      </main>

      {/* Footer */}
      <footer className={styles.footer}>
        <p>Club Engine 2026 - Club Arena</p>
      </footer>
    </div>
  );
}
