/**
 *  CLUB ENGINE — App Layout
 * Main shell layout with navigation
 * ═══════════════════════════════════════════════════════════════════════════════
 * GLOBAL COMPONENTS WIRED:
 * - GlobalHeader: Contains hamburger menu for quick navigation
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

export default function AppLayout() {
  const location = useLocation();

  // Detect if running inside iframe (World Hub embedding)
  // Use state to ensure correct value after client-side hydration
  const [isInIframe, setIsInIframe] = useState(false);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const inIframe = window.parent !== window;
    setIsInIframe(inIframe);

    // Also add class to body so CSS can hide header immediately
    if (inIframe) {
      document.body.classList.add('embedded-in-iframe');
    }
    return () => {
      document.body.classList.remove('embedded-in-iframe');
    };
  }, []);

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

  // Hide global header on table and tournament play pages
  const isTablePage =
    location.pathname.startsWith('/table') ||
    (location.pathname.startsWith('/tournaments/') && location.pathname.endsWith('/play'));
  const showGlobalHeader = !isInIframe && !isTablePage;

  return (
    <div className={`${styles.layout} ${isInIframe ? styles.embedded : ''}`}>
      {/* First-time Welcome Modal - Always show regardless of iframe */}
      {isReady && !isInIframe && (
        <ClubArenaWelcomeModal isOpen={showWelcome} onAccept={acceptWelcome} />
      )}

      {/* Global Header — Always visible outside iframes, except on active table pages */}
      {showGlobalHeader && <GlobalHeader pageDepth={2} />}

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
          ⚠️ You are offline — changes will sync when connection is restored
        </div>
      )}

      {/* Main Content */}
      <main id="main-content" className={styles.main}>
        <RouteErrorBoundary>
          <Outlet />
        </RouteErrorBoundary>
      </main>

      {/* Footer - Hide when in iframe */}
      {!isInIframe && (
        <footer className={styles.footer}>
          <p>Club Engine 2026 - Club Arena</p>
        </footer>
      )}
    </div>
  );
}
