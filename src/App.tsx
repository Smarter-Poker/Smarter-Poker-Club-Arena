/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — App Component
 * ═══════════════════════════════════════════════════════════════════════════════
 * PokerBros Clone — Better
 * Root application with routing, auth guards, and global providers
 */

import { Routes, Route, useLocation } from 'react-router-dom';
import { Suspense, lazy, useState, useEffect, useRef } from 'react';
import { supabase } from './lib/supabase';
import { realtimeChannelService } from './services/RealtimeChannelService';
import { replayOfflineQueue } from './utils/offlineQueue';
import { busEventLogger } from './services/BusEventLogger';
import GlobalWaitlistListener from './components/common/GlobalWaitlistListener';
import WaitlistBanner from './components/common/WaitlistBanner';

// Intro Video for first-time load
import IntroVideo from './components/IntroVideo';
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

  // ── Receive auth token from parent World Hub via postMessage ──
  // When embedded in an iframe at smarter.poker, the parent sends
  // the Supabase auth token so the SPA can authenticate without
  // requiring a separate login flow.
  const lastAuthTokenRef = useRef<string | null>(null);

  useEffect(() => {
    const isInIframe = window.parent !== window;
    if (!isInIframe) return;

    /** Apply settings from World Hub to the local Zustand store */
    const applySettings = (s: Record<string, unknown>) => {
      const store = useSettingsStore.getState();
      if (typeof s.soundEnabled === 'boolean' && s.soundEnabled !== store.soundEnabled)
        store.toggleSound();
      if (typeof s.fourColorDeck === 'boolean' && s.fourColorDeck !== store.fourColorDeck)
        store.toggleFourColorDeck();
      if (s.theme && s.theme !== store.theme) store.setTheme(s.theme as 'dark' | 'light');
    };

    const handleMessage = async (event: MessageEvent) => {
      // Accept from smarter.poker OR localhost:3000 for local dev
      if (!event.origin.includes('smarter.poker') && event.origin !== 'http://localhost:3000')
        return;

      if (event.data?.type === 'SMARTER_AUTH_TOKEN' && event.data.token) {
        // Send ACK immediately to halt World Hub retry loop.
        const parentOrigin = event.origin;
        window.parent.postMessage({ type: 'SMARTER_AUTH_ACK' }, parentOrigin);

        // Bridge Global Settings from World Hub instantly
        if (event.data.settings) {
          applySettings(event.data.settings);
        }

        // Improvement #4: Skip redundant setSession if token hasn't changed
        if (lastAuthTokenRef.current === event.data.token) return;
        lastAuthTokenRef.current = event.data.token;

        try {
          await supabase.auth.setSession({
            access_token: event.data.token,
            refresh_token: event.data.refreshToken || '',
          });
        } catch (e) {
          console.error('[App] Failed to set session from parent:', e);
        }
      }

      // Live settings push — World Hub user changed theme/sound/deck while iframe is open
      if (event.data?.type === 'SMARTER_SETTINGS_UPDATE' && event.data.settings) {
        applySettings(event.data.settings);
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
    try {
      window.parent.postMessage({ type: 'CLUB_ARENA_ROUTE_CHANGE', route }, '*');
    } catch {
      /* best effort */
    }
  }, [location.pathname]);

  // ── Heartbeat: Periodically tell the parent we're still alive ──
  useEffect(() => {
    const isInIframe = window.parent !== window;
    if (!isInIframe) return;

    const HEARTBEAT_INTERVAL = 30_000; // 30 seconds
    const heartbeatId = setInterval(() => {
      try {
        window.parent.postMessage({ type: 'CLUB_ARENA_HEARTBEAT' }, '*');
      } catch {
        /* best effort */
      }
    }, HEARTBEAT_INTERVAL);

    // Send one immediately on mount
    try {
      window.parent.postMessage({ type: 'CLUB_ARENA_HEARTBEAT' }, '*');
    } catch {
      /* best effort — ignore postMessage errors from detached frames */
    }

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

  // ── Start BusEventLogger & register Service Worker ──
  useEffect(() => {
    busEventLogger.start();

    // Register SW for background notifications
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw-bus.js').catch((_err) => {
        void 0; /* SW not supported or blocked */
      });
    }

    // Boot all engine services
    bootServices().catch((err) => {
      console.error('[App] Service bootstrap failed:', err);
    });

    return () => {
      busEventLogger.stop();
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
          <IntroVideo
            videoSrc="/videos/club-arena-intro.mp4"
            minDuration={3000}
            maxDuration={10000}
            onComplete={handleIntroComplete}
          />
        )}

        <TOSGuard>
          <GlobalWaitlistListener />
          <WaitlistBanner />
          {/* Offline Banner */}
          {isOffline && (
            <div
              style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                zIndex: 9999,
                background: 'linear-gradient(135deg, #b91c1c 0%, #991b1b 100%)',
                color: '#fff',
                textAlign: 'center',
                padding: '8px 16px',
                fontSize: '0.8rem',
                fontWeight: 700,
                letterSpacing: '0.5px',
                boxShadow: '0 2px 8px rgba(185,28,28,0.4)',
              }}
            >
              CONNECTION LOST — Actions will be queued and replayed when you reconnect
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
                  path="players"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Players">
                        <PlayerSessionsPage />
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
                  path="rakeback"
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
                  path="notifications"
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

                {/* Legal Pages */}
                <Route
                  path="legal/tos"
                  element={
                    <AuthGuard>
                      <TermsOfServicePage />
                    </AuthGuard>
                  }
                />
                <Route
                  path="legal/promotions"
                  element={
                    <AuthGuard>
                      <ClubPromotionRulesPage />
                    </AuthGuard>
                  }
                />
                <Route
                  path="legal/fair-gaming"
                  element={
                    <AuthGuard>
                      <FairGamingPage />
                    </AuthGuard>
                  }
                />
                <Route
                  path="legal/privacy"
                  element={
                    <AuthGuard>
                      <PrivacyPolicyPage />
                    </AuthGuard>
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
                      <a
                        href="/lobby"
                        className="px-6 py-3 bg-green-600 rounded-lg hover:bg-green-700 transition-colors"
                      >
                        Back to Lobby
                      </a>
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
