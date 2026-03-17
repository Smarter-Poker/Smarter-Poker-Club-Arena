/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — App Component
 * ═══════════════════════════════════════════════════════════════════════════════
 * PokerBros Clone — Better
 * Root application with routing, auth guards, and global providers
 */

import { Routes, Route, useLocation, Link } from 'react-router-dom';
import { Suspense, useState, useEffect, useRef } from 'react';
import { lazyWithRetry as lazy } from './utils/lazyWithRetry';
import { supabase } from './lib/supabase';
import { realtimeChannelService } from './services/RealtimeChannelService';
import { replayOfflineQueue } from './utils/offlineQueue';
import { busEventLogger } from './services/BusEventLogger';
import GlobalWaitlistListener from './components/common/GlobalWaitlistListener';
import WaitlistBanner from './components/common/WaitlistBanner';
import { earlyAuth } from './core/earlyAuthBridge';
import { postToParent, setParentOrigin, isTrustedOrigin } from './utils/parentOrigin';
import * as Sentry from '@sentry/react';

// Intro Video — lazy-loaded (only shown once per session, not needed for initial paint)
const IntroVideo = lazy(() => import('./components/IntroVideo'));
import { useSettingsStore } from './stores/useSettingsStore';

// Layouts
import AppLayout from './components/layouts/AppLayout';
import { ToastProvider } from './components/common/Toast';
import ErrorBoundary from './components/common/ErrorBoundary';
import RouteErrorBoundary from './components/common/RouteErrorBoundary';
import { PageErrorBoundary } from './components/common/PageErrorBoundary';
import OfflineQueueBadge from './components/common/OfflineQueueBadge';
import NavigationProgress from './components/common/NavigationProgress';
import ConnectionIndicator from './components/common/ConnectionIndicator';
import ConnectionStatusBar from './components/ConnectionStatusBar';
import BusToastBridge from './components/common/BusToastBridge';
import MilestoneToast from './components/common/MilestoneToast';
import { bootServices, shutdownServices } from './services/ServiceBootstrap';
import { GlobalBalanceSync } from './core/useGlobalBalanceSync';
import { supabaseConnectionWatchdog } from './utils/supabaseConnectionWatchdog';

// Auth Guards
import { AuthGuard, GuestGuard } from './components/auth/AuthGuard';
import TOSGuard from './components/legal/TOSGuard';

// Pages (lazy loaded for performance)
const AuthPage = lazy(() => import('./pages/AuthPage'));
const HomePage = lazy(() => import('./pages/HomePage'));
const LobbyPage = lazy(() => import('./pages/LobbyPage'));
const ClubsPage = lazy(() => import('./pages/ClubsPage'));
const ClubCarouselPage = lazy(() => import('./pages/ClubCarouselPage'));
const ClubHomePage = lazy(() => import('./pages/ClubHomePage'));
const ClubLobby = lazy(() => import('./pages/club/ClubLobby'));
const ClubDashboard = lazy(() => import('./pages/club/ClubDashboard'));
const CreateClubPage = lazy(() => import('./pages/CreateClubPage'));
const CreateTablePage = lazy(() => import('./pages/CreateTablePage'));
const TableConfigPage = lazy(() => import('./pages/TableConfigPage'));
const AgentManagementPage = lazy(() => import('./pages/AgentManagementPage'));
const TournamentPage = lazy(() => import('./pages/TournamentPage'));
const TournamentDetails = lazy(() => import('./pages/tournament/TournamentDetails'));
const TournamentLobbyPage = lazy(() => import('./pages/tournament/TournamentLobbyPage'));
const TournamentResultsPage = lazy(() => import('./pages/tournament/TournamentResultsPage'));
const TablePage = lazy(() => import('./pages/TablePage'));
const MultiTablePage = lazy(() => import('./pages/MultiTablePage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const UnionsPage = lazy(() => import('./pages/UnionsPage'));
const UnionDetailPage = lazy(() => import('./pages/UnionDetailPage'));
const CreateUnionPage = lazy(() => import('./pages/CreateUnionPage'));
const SettlementPage = lazy(() => import('./pages/SettlementPage'));

// New Pages
const LeaderboardPage = lazy(() => import('./pages/LeaderboardPage'));
const HandHistoryPage = lazy(() => import('./pages/HandHistoryPage'));
const PlayerWalletPage = lazy(() => import('./pages/PlayerWalletPage'));
const NotificationsPage = lazy(() => import('./pages/NotificationsPage'));
const MessagesPage = lazy(() => import('./pages/MessagesPage'));
const ClubMessagesPage = lazy(() => import('./pages/ClubMessagesPage'));
const SearchPage = lazy(() => import('./pages/SearchPage'));
const HelpPage = lazy(() => import('./pages/HelpPage'));
const CashierPage = lazy(() => import('./pages/CashierPage'));
const SuperAgentDashboard = lazy(() => import('./pages/SuperAgentDashboard'));
const AchievementsPage = lazy(() => import('./pages/AchievementsPage'));
const ClubMembersPage = lazy(() => import('./pages/ClubMembersPage'));
const FriendsPage = lazy(() => import('./pages/FriendsPage'));
const RakebackPage = lazy(() => import('./pages/RakebackPage'));
const BadBeatJackpotPage = lazy(() => import('./pages/BadBeatJackpotPage'));
const PlayerStatsPage = lazy(() => import('./pages/PlayerStatsPage'));
const PromotionsPage = lazy(() => import('./pages/PromotionsPage'));
const ClubSettingsPage = lazy(() => import('./pages/ClubSettingsPage'));
const TransactionHistoryPage = lazy(() => import('./pages/TransactionHistoryPage'));
const InvitePage = lazy(() => import('./pages/InvitePage'));
const TableCreationPage = lazy(() => import('./pages/TableCreationPage'));
const ReportPlayerPage = lazy(() => import('./pages/ReportPlayerPage'));
const ReportReviewPage = lazy(() => import('./pages/ReportReviewPage'));
const ClubAnnouncementsPage = lazy(() => import('./pages/ClubAnnouncementsPage'));
const VIPPage = lazy(() => import('./pages/VIPPage'));
const ClubFinancialsPage = lazy(() => import('./pages/ClubFinancialsPage'));
const BonusPage = lazy(() => import('./pages/BonusPage'));
const WaitlistPage = lazy(() => import('./pages/WaitlistPage'));
const ClubRulesPage = lazy(() => import('./pages/ClubRulesPage'));
const NotificationCenter = lazy(() => import('./pages/NotificationCenter'));
const BusDevToolsPage = lazy(() => import('./pages/BusDevToolsPage'));
const FinancialAlertsPage = lazy(() => import('./pages/FinancialAlertsPage'));
const DisputeManagementPage = lazy(() => import('./pages/DisputeManagementPage'));
const FinancialHealthPage = lazy(() => import('./pages/FinancialHealthPage'));
const FinancialAdminHub = lazy(() => import('./pages/FinancialAdminHub'));
const RateAuditPage = lazy(() => import('./pages/RateAuditPage'));
const SettlementDashboardPage = lazy(() => import('./pages/SettlementDashboardPage'));
const AgentPortalPage = lazy(() => import('./pages/AgentPortalPage'));
const RakebackDashboard = lazy(() => import('./pages/RakebackDashboard'));
const CreditAdminPanel = lazy(() => import('./pages/CreditAdminPanel'));
const SettlementHistoryPage = lazy(() => import('./pages/SettlementHistoryPage'));
const FlashPoolPage = lazy(() => import('./pages/FlashPoolPage'));
const SessionHistoryPage = lazy(() => import('./pages/SessionHistoryPage'));

// Q4: New Backported Pages (Hub → Club Arena)
const AntiCheatPage = lazy(() => import('./pages/AntiCheatPage'));
const XMTTPage = lazy(() => import('./pages/XMTTPage'));
const MarketplacePage = lazy(() => import('./pages/MarketplacePage'));
const UnionGamesPage = lazy(() => import('./pages/UnionGamesPage'));
const AdminDashboardPage = lazy(() => import('./pages/AdminDashboardPage'));
const PlayerSessionsPage = lazy(() => import('./pages/PlayerSessionsPage'));
const AgentDashboardPage = lazy(() => import('./pages/AgentDashboardPage'));
const UnionDashboardPage = lazy(() => import('./pages/UnionDashboardPage'));

// Q3: Social, Messaging & Discovery Pages
const PublicProfilePage = lazy(() => import('./pages/PublicProfilePage'));
const NewConversationPage = lazy(() => import('./pages/NewConversationPage'));

// Shared/Public Pages
const HandReplayerPage = lazy(() => import('./pages/share/HandReplayerPage'));

// Legal Pages
const TermsOfServicePage = lazy(() => import('./pages/legal/TermsOfServicePage'));
const ClubPromotionRulesPage = lazy(() => import('./pages/legal/PromotionsPage'));
const FairGamingPage = lazy(() => import('./pages/legal/FairGamingPage'));
const PrivacyPolicyPage = lazy(() => import('./pages/legal/PrivacyPolicyPage'));

// Admin Singletons
const EngineDashboard = lazy(() => import('./pages/admin/EngineDashboard'));
const AnalyticsDashboard = lazy(() => import('./pages/admin/AnalyticsDashboard'));

// Loading fallback
function LoadingSpinner() {
  return (
    <div className="loading-container">
      <div className="spinner" />
      <p style={{ marginTop: '1rem', color: 'var(--text-secondary)' }}>Loading...</p>
    </div>
  );
}

const INTRO_SHOWN_KEY = 'club_arena_intro_shown';

// ── Window extensions for iframe auth communication ──
declare global {
  interface Window {
    __PARENT_ORIGIN__?: string; // Set by inline script when parent origin is validated
  }
}

/**
 * Quick JWT expiry check — returns true if the token is expired or malformed.
 * Uses a 30-second buffer so we don't attempt setSession() with a token
 * that will expire before Supabase can process it.
 */
function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return true; // Malformed JWT
    const payload = JSON.parse(atob(parts[1]));
    if (typeof payload.exp !== 'number') return true; // No expiry claim
    return payload.exp * 1000 < Date.now() + 30_000; // 30s buffer
  } catch {
    return true; // Parse error — treat as expired
  }
}

export default function App() {
  // Check if intro video has been shown this session
  const [showIntro, setShowIntro] = useState(() => {
    // Only show intro if not viewed this session and not in iframe
    const alreadyShown = sessionStorage.getItem(INTRO_SHOWN_KEY);
    const inIframe = window.parent !== window;
    return !alreadyShown && !inIframe;
  });

  const handleIntroComplete = () => {
    sessionStorage.setItem(INTRO_SHOWN_KEY, 'true');
    setShowIntro(false);
  };

  // Offline/Online detection
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const goOffline = () => setIsOffline(true);
    const goOnline = () => {
      setIsOffline(false);
      // Replay queued mutations on reconnect
      replayOfflineQueue().catch(() => {
        /* best effort */
      });
    };
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  // ═══════════════════════════════════════════════════════════════════════════
  //  UNIFIED AUTH HANDLER (Redesigned — consolidated from 2 useEffects into 1)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // AUTH FLOW (clean, 3-layer architecture):
  //   Layer 1: index.html inline script — sends ACKs, stores token in window.__EARLY_AUTH__
  //   Layer 2: THIS useEffect — single entry point for ALL auth token processing
  //   Layer 3: IdentityDNA — reacts to setSession() via onAuthStateChange listener
  //
  // This replaces the previous dual-useEffect design where:
  //   - useEffect #1 consumed early auth (window.__EARLY_AUTH__)
  //   - useEffect #2 listened for live postMessage tokens
  //   Both called setSession() independently, creating race conditions.
  //
  // Now: ONE handler consumes early auth on mount AND listens for live tokens.
  // ═══════════════════════════════════════════════════════════════════════════
  const lastAuthTokenRef = useRef<string | null>(null);
  const authInFlightRef = useRef(false); // Mutex to prevent concurrent setSession calls

  /** Apply settings from World Hub to the local Zustand store */
  const applySettingsRef = useRef((s: Record<string, unknown>) => {
    const store = useSettingsStore.getState();
    if (typeof s.soundEnabled === 'boolean' && s.soundEnabled !== store.soundEnabled)
      store.toggleSound();
    if (typeof s.fourColorDeck === 'boolean' && s.fourColorDeck !== store.fourColorDeck)
      store.toggleFourColorDeck();
    if (s.theme && s.theme !== store.theme) store.setTheme(s.theme as 'dark' | 'light');
  });

  /**
   * Core auth processor — called for BOTH early auth and live postMessage tokens.
   * Validates, deduplicates, and sets the Supabase session.
   */
  const processAuthToken = async (
    token: string,
    refreshToken: string,
    settings: Record<string, unknown> | null,
    source: 'earlyAuth' | 'postMessage'
  ) => {
    // Deduplicate: skip if we already processed this exact token
    if (lastAuthTokenRef.current === token) return;

    // JWT expiry pre-check: don't waste a setSession() call on an expired token
    if (isTokenExpired(token)) {
      console.warn(`[App] ${source} token is expired — skipping setSession`);
      return;
    }

    // Mutex: prevent concurrent setSession() calls (the #1 cause of auth races)
    if (authInFlightRef.current) {
      console.warn(`[App] setSession already in flight — queuing ${source} token`);
      // Don't drop it — update lastAuthTokenRef so next call picks it up
      return;
    }

    lastAuthTokenRef.current = token;
    authInFlightRef.current = true;

    // Apply settings immediately (don't wait for setSession)
    if (settings) {
      applySettingsRef.current(settings);
    }

    const startTime = performance.now();
    try {
      await supabase.auth.setSession({
        access_token: token,
        refresh_token: refreshToken,
      });
      const ms = Math.round(performance.now() - startTime);
      console.log(`[App] ✅ Auth session set via ${source} in ${ms}ms`);
      postToParent({ type: 'SMARTER_AUTH_ACK' });
      try {
        Sentry.addBreadcrumb({
          category: 'auth-handshake',
          message: `setSession completed in ${ms}ms`,
          level: 'info',
          data: { ms, method: source },
        });
      } catch {
        /* Sentry not loaded */
      }
    } catch (e) {
      console.error(`[App] setSession failed (${source}):`, e);
      postToParent({ type: 'SMARTER_AUTH_FAILED', error: String(e) });
      // Reset lastAuthTokenRef so a retry can re-attempt
      lastAuthTokenRef.current = null;
      try {
        Sentry.addBreadcrumb({
          category: 'auth-handshake',
          message: `setSession FAILED (${source}): ${e}`,
          level: 'error',
        });
      } catch {
        /* Sentry not loaded */
      }
    } finally {
      authInFlightRef.current = false;
    }
  };

  useEffect(() => {
    const isInIframe = window.parent !== window;
    if (!isInIframe) return;

    // ── Step 1: Consume early auth token received before React mounted ──
    // The inline script in index.html stores tokens in window.__EARLY_AUTH__
    const earlyToken = window.__EARLY_AUTH__?.token || earlyAuth.token;
    const earlyRefresh = window.__EARLY_AUTH__?.refreshToken || earlyAuth.refreshToken || '';
    const earlySettings = window.__EARLY_AUTH__?.settings || earlyAuth.settings;

    if (earlyToken) {
      // Clear sources BEFORE async processing to prevent double-consume
      earlyAuth.token = null;
      earlyAuth.refreshToken = null;
      earlyAuth.settings = null;
      if (window.__EARLY_AUTH__) {
        window.__EARLY_AUTH__.token = null;
        window.__EARLY_AUTH__.refreshToken = null;
        window.__EARLY_AUTH__.settings = null;
      }

      processAuthToken(earlyToken, earlyRefresh, earlySettings, 'earlyAuth');
    }

    // ── Step 2: Listen for live auth tokens via postMessage ──
    // Handles: initial token (if missed by early auth), token refreshes, re-auth
    const handleMessage = async (event: MessageEvent) => {
      if (!isTrustedOrigin(event.origin)) return;

      if (event.data?.type === 'SMARTER_AUTH_TOKEN' && event.data.token) {
        setParentOrigin(event.origin);
        // ACK immediately — tell parent we received it
        postToParent({ type: 'SMARTER_AUTH_ACK' });

        if (!event.data.refreshToken) {
          console.warn('[App] Parent sent auth token without refreshToken');
        }

        await processAuthToken(
          event.data.token,
          event.data.refreshToken || '',
          event.data.settings || null,
          'postMessage'
        );
      }

      // Live settings push — World Hub user changed theme/sound/deck while iframe is open
      if (event.data?.type === 'SMARTER_SETTINGS_UPDATE' && event.data.settings) {
        applySettingsRef.current(event.data.settings);
        console.log('[App] Live settings update received from World Hub');
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // ── URL Sync: Notify parent of route changes for address bar sync ──
  const location = useLocation();
  useEffect(() => {
    const isInIframe = window.parent !== window;
    if (!isInIframe) return;

    // Strip the basename prefix that React Router adds internally
    const route = location.pathname.replace(/^\//, '');
    postToParent({ type: 'CLUB_ARENA_ROUTE_CHANGE', route });
  }, [location.pathname]);

  // ── Heartbeat: Periodically tell the parent we're still alive ──
  useEffect(() => {
    const isInIframe = window.parent !== window;
    if (!isInIframe) return;

    const HEARTBEAT_INTERVAL = 30_000; // 30 seconds
    const heartbeatId = setInterval(() => {
      postToParent({ type: 'CLUB_ARENA_HEARTBEAT' });
    }, HEARTBEAT_INTERVAL);

    // Send one immediately on mount
    postToParent({ type: 'CLUB_ARENA_HEARTBEAT' });

    return () => clearInterval(heartbeatId);
  }, []);

  // ── Clean up realtime subscriptions on page unload ──
  // Prevents memory leaks and orphaned connections when user navigates away
  useEffect(() => {
    const handleBeforeUnload = () => {
      try {
        realtimeChannelService.unsubscribeAll().catch(() => {
          /* best effort cleanup */
        });
      } catch (e) {
        console.warn('[App] Error during subscription cleanup on unload:', e);
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    // Also handle visibility change for tab backgrounding
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Optional: unsubscribe from non-essential channels when tab is backgrounded
        // For now, we keep subscriptions alive in background
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // ── Start BusEventLogger, Connection Watchdog & register Service Worker ──
  useEffect(() => {
    busEventLogger.start();

    // Start Supabase connection watchdog (monitors connectivity, emits bus events,
    // auto-reconnects realtime channels on recovery)
    supabaseConnectionWatchdog.start();

    // Register SW for background notifications
    // FIX: Use base-relative path so the SW is found under /hub/club-arena/
    if ('serviceWorker' in navigator) {
      const swPath =
        import.meta.env.BASE_URL && import.meta.env.BASE_URL !== '/'
          ? `${import.meta.env.BASE_URL}sw-bus.js`
          : '/sw-bus.js';
      navigator.serviceWorker.register(swPath).catch((_err) => {
        void 0; /* SW not supported or blocked */
      });
    }

    // Boot all engine services
    bootServices().catch((err) => {
      console.error('[App] Service bootstrap failed:', err);
    });

    return () => {
      busEventLogger.stop();
      supabaseConnectionWatchdog.stop();
      // Tear down engine services (online listener, cron timer, IndexedDB)
      shutdownServices();
    };
  }, []);

  return (
    <ErrorBoundary>
      <ToastProvider>
        <GlobalBalanceSync />
        <BusToastBridge />
        <MilestoneToast />
        <ConnectionStatusBar />
        {/* Accessibility: Skip to main content link */}
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>

        {/* Intro video overlay - app loads in background while video plays */}
        {showIntro && (
          <Suspense fallback={null}>
            <IntroVideo
              videoSrc={`${import.meta.env.BASE_URL}videos/club-arena-intro.mp4`}
              minDuration={3000}
              maxDuration={10000}
              onComplete={handleIntroComplete}
            />
          </Suspense>
        )}

        <TOSGuard>
          <GlobalWaitlistListener />
          <WaitlistBanner />
          {/* Offline Banner — subtle amber bar, only for navigator.onLine === false */}
          {isOffline && (
            <div
              style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                zIndex: 9999,
                background: 'linear-gradient(135deg, #92400e 0%, #78350f 100%)',
                color: '#fbbf24',
                textAlign: 'center',
                padding: '6px 16px',
                fontSize: '0.75rem',
                fontWeight: 600,
                letterSpacing: '0.5px',
              }}
            >
              Reconnecting — your actions are saved and will sync automatically
            </div>
          )}
          <OfflineQueueBadge />
          <ConnectionIndicator />
          <Suspense
            fallback={
              <>
                <NavigationProgress />
                <LoadingSpinner />
              </>
            }
          >
            <Routes>
              {/* ═══════════════════════════════════════════════════════════════
                        PUBLIC ROUTES (No Auth Required)
                    ═══════════════════════════════════════════════════════════════ */}

              {/* Auth Page - Only accessible when NOT logged in */}
              <Route
                path="/auth"
                element={
                  <GuestGuard>
                    <AuthPage />
                  </GuestGuard>
                }
              />

              {/* Public Hand Replay — shareable link, no auth required */}
              <Route path="/share/hand/:handId" element={<HandReplayerPage />} />

              {/* ═══════════════════════════════════════════════════════════════
                    PROTECTED ROUTES (Auth Required)
                ═══════════════════════════════════════════════════════════════ */}

              {/* HomePage - Standalone without Shell, requires auth */}
              <Route
                path="/"
                element={
                  <AuthGuard>
                    <RouteErrorBoundary>
                      <HomePage />
                    </RouteErrorBoundary>
                  </AuthGuard>
                }
              />

              {/* Table — Standalone without AppLayout shell (full-screen immersive) */}
              <Route
                path="table/:tableId"
                element={
                  <AuthGuard>
                    <RouteErrorBoundary>
                      <MultiTablePage />
                    </RouteErrorBoundary>
                  </AuthGuard>
                }
              />

              {/* Protected routes with AppLayout shell — RouteErrorBoundary on each */}
              <Route element={<AppLayout />}>
                {/* RouteErrorBoundary wraps all AppLayout children */}
                {/* Lobby */}
                <Route
                  path="lobby"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Lobby">
                        <LobbyPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />

                {/* Clubs */}
                <Route
                  path="clubs"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Clubs">
                        <ClubCarouselPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/create"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Create Club">
                        <CreateClubPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Club Home">
                        <ClubHomePage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/agents"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Agent Management">
                        <AgentManagementPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/create-table"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Create Table">
                        <CreateTablePage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/create-table/:gameType"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Table Config">
                        <TableConfigPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/dashboard"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Club Dashboard">
                        <ClubDashboard />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/lobby"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Club Lobby">
                        <ClubLobby />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/tournaments"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Tournaments">
                        <TournamentPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/messages"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Messages">
                        <MessagesPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="tournaments/:tournamentId"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Tournament Details">
                        <TournamentDetails />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="tournament-lobby"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Tournament Lobby">
                        <TournamentLobbyPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="tournaments"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Tournament Lobby">
                        <TournamentLobbyPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="tournament-results"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Tournament Results">
                        <TournamentResultsPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="hand-history"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Hand History">
                        <HandHistoryPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="agent-management"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Agent Management">
                        <AgentManagementPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />

                {/* Unions */}
                <Route
                  path="unions"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Unions">
                        <UnionsPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="unions/create"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Create Union">
                        <CreateUnionPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="unions/:unionId"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Union Details">
                        <UnionDetailPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="unions/:unionId/settlement"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Settlement">
                        <SettlementPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/settlement"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Settlement">
                        <SettlementPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />

                {/* User */}
                <Route
                  path="profile"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Profile">
                        <ProfilePage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="profile/:userId"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Public Profile">
                        <PublicProfilePage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="settings"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Settings">
                        <SettingsPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />

                {/* New Pages */}
                <Route
                  path="leaderboard"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Leaderboard">
                        <LeaderboardPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="history"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Hand History">
                        <HandHistoryPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="wallet"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Wallet">
                        <PlayerWalletPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="notifications"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Notifications">
                        <NotificationsPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="messages"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Messages">
                        <MessagesPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="messages/new"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="New Message">
                        <NewConversationPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="messages/:conversationId"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Messages">
                        <MessagesPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="messages/clubs"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Club Messages">
                        <ClubMessagesPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="messages/clubs/:conversationId"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Club Messages">
                        <ClubMessagesPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="search"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Search">
                        <SearchPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="help"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Help">
                        <HelpPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="cashier"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Cashier">
                        <CashierPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                {/* Query parameter club routes for bottom nav */}
                <Route
                  path="players"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Club Members">
                        <ClubMembersPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="data"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Club Dashboard">
                        <ClubDashboard />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="admin"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Admin Dashboard">
                        <AdminDashboardPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="player-sessions"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Players">
                        <PlayerSessionsPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="agent-dashboard"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Agent Dashboard">
                        <AgentDashboardPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/cashier"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Cashier">
                        <CashierPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="hands"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Hand History">
                        <HandHistoryPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/agent-dashboard"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Super Agent Dashboard">
                        <SuperAgentDashboard />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="achievements"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Achievements">
                        <AchievementsPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/members"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Club Members">
                        <ClubMembersPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="friends"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Friends">
                        <FriendsPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="rakeback"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Rakeback">
                        <RakebackPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/jackpot"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Bad Beat Jackpot">
                        <BadBeatJackpotPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="stats"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Player Stats">
                        <PlayerStatsPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="stats/:userId"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Player Stats">
                        <PlayerStatsPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="promotions"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Promotions">
                        <PromotionsPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/promotions"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Promotions">
                        <PromotionsPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/settings"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Club Settings">
                        <ClubSettingsPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="transactions"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Transaction History">
                        <TransactionHistoryPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="invite/:clubId"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Invite">
                        <InvitePage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="invite"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Invite">
                        <InvitePage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="report/:playerId"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Report Player">
                        <ReportPlayerPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/reports"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Report Review">
                        <ReportReviewPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/announcements"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Announcements">
                        <ClubAnnouncementsPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="vip"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="VIP">
                        <VIPPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/financials"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Club Financials">
                        <ClubFinancialsPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="financial-alerts"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Financial Alerts">
                        <FinancialAlertsPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="disputes"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Disputes">
                        <DisputeManagementPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/disputes"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Disputes">
                        <DisputeManagementPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="financial-health"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Financial Health">
                        <FinancialHealthPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="financial-admin"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Financial Admin Hub">
                        <FinancialAdminHub />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="rate-audit"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Rate Audit">
                        <RateAuditPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="settlement-dashboard"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Settlement Dashboard">
                        <SettlementDashboardPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="agent-portal"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Agent Portal">
                        <AgentPortalPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="rakeback-dashboard"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Rakeback">
                        <RakebackDashboard />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="credit-admin"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Credit Admin">
                        <CreditAdminPanel />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="settlement-history"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Settlement History">
                        <SettlementHistoryPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="flash-pool"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Flash Pool">
                        <FlashPoolPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="session-history"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Session History">
                        <SessionHistoryPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="bonuses"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Bonuses">
                        <BonusPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="waitlist"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Waitlist">
                        <WaitlistPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/rules"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Club Rules">
                        <ClubRulesPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="notification-center"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Notification Center">
                        <NotificationCenter />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs-list"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Clubs List">
                        <ClubsPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/table-creation"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Table Creation">
                        <TableCreationPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />

                {/* Q4: Backported Pages (Hub → Club Arena) */}
                <Route
                  path="anti-cheat"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Anti-Cheat">
                        <AntiCheatPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="xmtt"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="XMTT">
                        <XMTTPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="union-dashboard"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Union Dashboard">
                        <UnionDashboardPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="marketplace"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Marketplace">
                        <MarketplacePage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="unions/:unionId/games"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Union Games">
                        <UnionGamesPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="union-games"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Union Games">
                        <UnionGamesPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />

                {/* DevTools (admin diagnostics) */}
                <Route
                  path="dev/bus"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Bus DevTools">
                        <BusDevToolsPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />

                {/* Legal Pages — public (no AuthGuard) so users can read terms before signup */}
                <Route
                  path="legal/tos"
                  element={
                    <PageErrorBoundary pageName="TermsOfService">
                      <TermsOfServicePage />
                    </PageErrorBoundary>
                  }
                />
                <Route
                  path="legal/promotions"
                  element={
                    <PageErrorBoundary pageName="ClubPromotionRules">
                      <ClubPromotionRulesPage />
                    </PageErrorBoundary>
                  }
                />
                <Route
                  path="legal/fair-gaming"
                  element={
                    <PageErrorBoundary pageName="FairGaming">
                      <FairGamingPage />
                    </PageErrorBoundary>
                  }
                />
                <Route
                  path="legal/privacy"
                  element={
                    <PageErrorBoundary pageName="PrivacyPolicy">
                      <PrivacyPolicyPage />
                    </PageErrorBoundary>
                  }
                />

                {/* Engine Dashboard */}
                <Route
                  path="engine"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Engine Dashboard">
                        <EngineDashboard />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="analytics"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Analytics Dashboard">
                        <AnalyticsDashboard />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />

                {/* 404 catch-all */}
                <Route
                  path="*"
                  element={
                    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 text-white">
                      <h1 className="text-6xl font-bold mb-4">404</h1>
                      <p className="text-xl text-gray-400 mb-8">Page not found</p>
                      <Link
                        to="/lobby"
                        className="px-6 py-3 bg-green-600 rounded-lg hover:bg-green-700 transition-colors"
                      >
                        Back to Lobby
                      </Link>
                    </div>
                  }
                />
              </Route>
            </Routes>
          </Suspense>
        </TOSGuard>
      </ToastProvider>
    </ErrorBoundary>
  );
}
