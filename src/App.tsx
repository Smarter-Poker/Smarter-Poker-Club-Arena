/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — App Component
 * ═══════════════════════════════════════════════════════════════════════════════
 * Smarter Poker Platform
 * Root application with routing, auth guards, and global providers
 */

import { Routes, Route, Link, Navigate } from 'react-router-dom';
import { SessionSummaryHost } from './components/session/SessionSummaryHost';
import TournamentRankingHost from './components/tournament/TournamentRankingHost';
import TournamentStartingTicker from './components/tournament/TournamentStartingTicker';
import TournamentAutoSeat from './components/tournament/TournamentAutoSeat';
import { MEDIA_BASE } from './utils/mediaBase';
import { Suspense, useState, useEffect } from 'react';
import { lazyWithRetry as lazy } from './utils/lazyWithRetry';
import { supabase } from './lib/supabase';
import { realtimeChannelService } from './services/RealtimeChannelService';
import { OfflineQueueService } from './services/OfflineQueueService';
import { busEventLogger } from './services/BusEventLogger';
import GlobalWaitlistListener from './components/common/GlobalWaitlistListener';
import { ChallengeToastListener } from './components/notifications/ChallengeToastListener';
import LastClubTracker from './components/common/LastClubTracker';
import WaitlistBanner from './components/common/WaitlistBanner';
import { addBreadcrumb } from './core/SentryInit';

// Intro Video — lazy-loaded (only shown once per session, not needed for initial paint)
const IntroVideo = lazyWithRetry(() => import('./components/IntroVideo'));
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
import PersistentTableLayer from './components/table/PersistentTableLayer';
import BusToastBridge from './components/common/BusToastBridge';
import { ConfirmHost } from './components/common/confirmDialog';
import MilestoneToast from './components/common/MilestoneToast';
import { bootServices, shutdownServices } from './services/ServiceBootstrap';
import { preloadCriticalChunks } from './utils/ChunkPreloader';
import { GlobalBalanceSync } from './core/useGlobalBalanceSync';
import { supabaseConnectionWatchdog } from './utils/supabaseConnectionWatchdog';

// Auth Guards
import { AuthGuard, GuestGuard } from './components/auth/AuthGuard';
import TOSGuard from './components/legal/TOSGuard';
import { lazyWithRetry } from './utils/lazyWithRetry';

// Pages (lazy loaded for performance)
const AuthPage = lazyWithRetry(() => import('./pages/AuthPage'));
const HomePage = lazyWithRetry(() => import('./pages/HomePage'));

const ClubsPage = lazyWithRetry(() => import('./pages/ClubsPage'));
const ClubHomePage = lazyWithRetry(() => import('./pages/ClubHomePage'));
const ClubDashboard = lazyWithRetry(() => import('./pages/club/ClubDashboard'));
const ClubDataPage = lazyWithRetry(() => import('./pages/club/ClubDataPage'));
const CreateClubPage = lazyWithRetry(() => import('./pages/CreateClubPage'));
const CreateTablePage = lazyWithRetry(() => import('./pages/CreateTablePage'));
const TableConfigPage = lazyWithRetry(() => import('./pages/TableConfigPage'));
const AgentManagementPage = lazyWithRetry(() => import('./pages/AgentManagementPage'));
const TournamentPage = lazyWithRetry(() => import('./pages/TournamentPage'));
const TournamentDetails = lazyWithRetry(() => import('./pages/tournament/TournamentDetails'));
const TournamentLobbyPage = lazyWithRetry(() => import('./pages/tournament/TournamentLobbyPage'));
const TournamentResultsPage = lazyWithRetry(
  () => import('./pages/tournament/TournamentResultsPage')
);
const TablePage = lazyWithRetry(() => import('./pages/TablePage'));
const ProfilePage = lazyWithRetry(() => import('./pages/ProfilePage'));
const DailyChallengesPage = lazyWithRetry(() => import('./pages/DailyChallengesPage'));
const SettingsPage = lazyWithRetry(() => import('./pages/SettingsPage'));
const UnionsPage = lazyWithRetry(() => import('./pages/UnionsPage'));
const UnionDetailPage = lazyWithRetry(() => import('./pages/UnionDetailPage'));
const UnionStatementsPage = lazyWithRetry(() => import('./pages/UnionStatementsPage'));
const CreateUnionPage = lazyWithRetry(() => import('./pages/CreateUnionPage'));
const SettlementPage = lazyWithRetry(() => import('./pages/SettlementPage'));

// New Pages
const LeaderboardPage = lazyWithRetry(() => import('./pages/LeaderboardPage'));
const HandHistoryPage = lazyWithRetry(() => import('./pages/HandHistoryPage'));
const PlayerWalletPage = lazyWithRetry(() => import('./pages/PlayerWalletPage'));
const NotificationsPage = lazyWithRetry(() => import('./pages/NotificationsPage'));
const MessagesPage = lazyWithRetry(() => import('./pages/MessagesPage'));
const ClubMessagesPage = lazyWithRetry(() => import('./pages/ClubMessagesPage'));
const SearchPage = lazyWithRetry(() => import('./pages/SearchPage'));
const HelpPage = lazyWithRetry(() => import('./pages/HelpPage'));
const CashierPage = lazyWithRetry(() => import('./pages/CashierPage'));
const CashierTradePage = lazyWithRetry(() => import('./pages/CashierTradePage'));
const SuperAgentDashboard = lazyWithRetry(() => import('./pages/SuperAgentDashboard'));
const AchievementsPage = lazyWithRetry(() => import('./pages/AchievementsPage'));
const ClubMembersPage = lazyWithRetry(() => import('./pages/ClubMembersPage'));
const FriendsPage = lazyWithRetry(() => import('./pages/FriendsPage'));
const RakebackPage = lazyWithRetry(() => import('./pages/RakebackPage'));
const BadBeatJackpotPage = lazyWithRetry(() => import('./pages/BadBeatJackpotPage'));
const PlayerStatsPage = lazyWithRetry(() => import('./pages/PlayerStatsPage'));
const PromotionsPage = lazyWithRetry(() => import('./pages/PromotionsPage'));
const ClubSettingsPage = lazyWithRetry(() => import('./pages/ClubSettingsPage'));
const TransactionHistoryPage = lazyWithRetry(() => import('./pages/TransactionHistoryPage'));
const InvitePage = lazyWithRetry(() => import('./pages/InvitePage'));
const TableCreationPage = lazyWithRetry(() => import('./pages/TableCreationPage'));
const ReportPlayerPage = lazyWithRetry(() => import('./pages/ReportPlayerPage'));
const ReportReviewPage = lazyWithRetry(() => import('./pages/ReportReviewPage'));
const ClubAnnouncementsPage = lazyWithRetry(() => import('./pages/ClubAnnouncementsPage'));
const VIPPage = lazyWithRetry(() => import('./pages/VIPPage'));
const ClubFinancialsPage = lazyWithRetry(() => import('./pages/ClubFinancialsPage'));
const BonusPage = lazyWithRetry(() => import('./pages/BonusPage'));
const WaitlistPage = lazyWithRetry(() => import('./pages/WaitlistPage'));
const ClubRulesPage = lazyWithRetry(() => import('./pages/ClubRulesPage'));
const NotificationCenter = lazyWithRetry(() => import('./pages/NotificationCenter'));
const BusDevToolsPage = lazyWithRetry(() => import('./pages/BusDevToolsPage'));
const FinancialAlertsPage = lazyWithRetry(() => import('./pages/FinancialAlertsPage'));
const DisputeManagementPage = lazyWithRetry(() => import('./pages/DisputeManagementPage'));
const FinancialHealthPage = lazyWithRetry(() => import('./pages/FinancialHealthPage'));
const FinancialAdminHub = lazyWithRetry(() => import('./pages/FinancialAdminHub'));
const RateAuditPage = lazyWithRetry(() => import('./pages/RateAuditPage'));
const SettlementDashboardPage = lazyWithRetry(() => import('./pages/SettlementDashboardPage'));
const AgentPortalPage = lazyWithRetry(() => import('./pages/AgentPortalPage'));
const RakebackDashboard = lazyWithRetry(() => import('./pages/RakebackDashboard'));
const CreditAdminPanel = lazyWithRetry(() => import('./pages/CreditAdminPanel'));
const SettlementHistoryPage = lazyWithRetry(() => import('./pages/SettlementHistoryPage'));
const FlashPoolPage = lazyWithRetry(() => import('./pages/FlashPoolPage'));
const BlacklistManagerPage = lazyWithRetry(() => import('./pages/BlacklistManagerPage'));
const SessionHistoryPage = lazyWithRetry(() => import('./pages/SessionHistoryPage'));

// Q4: New Backported Pages (Hub → Club Arena)
const AntiCheatPage = lazyWithRetry(() => import('./pages/AntiCheatPage'));
const XMTTPage = lazyWithRetry(() => import('./pages/XMTTPage'));
const MarketplacePage = lazyWithRetry(() => import('./pages/MarketplacePage'));
const UnionGamesPage = lazyWithRetry(() => import('./pages/UnionGamesPage'));
const AdminDashboardPage = lazyWithRetry(() => import('./pages/AdminDashboardPage'));
const PlayerSessionsPage = lazyWithRetry(() => import('./pages/PlayerSessionsPage'));
const AgentDashboardPage = lazyWithRetry(() => import('./pages/AgentDashboardPage'));
const UnionDashboardPage = lazyWithRetry(() => import('./pages/UnionDashboardPage'));

// Q3: Social, Messaging & Discovery Pages
const PublicProfilePage = lazyWithRetry(() => import('./pages/PublicProfilePage'));

// Shared/Public Pages
const HandReplayerPage = lazyWithRetry(() => import('./pages/share/HandReplayerPage'));
// VISIBLE FIX 2026-08-15: ShareHand emits /replay?h=<payload> for every share
// channel, and no such route existed — every shared link 404'd.
const SharedHandReplayPage = lazyWithRetry(() => import('./pages/share/SharedHandReplayPage'));
const SimPage = lazyWithRetry(() => import('./pages/SimPage'));

// System Pages
const HealthCheckPage = lazyWithRetry(() => import('./pages/HealthCheckPage'));

// Legal Pages
const TermsOfServicePage = lazyWithRetry(() => import('./pages/legal/TermsOfServicePage'));
const ClubPromotionRulesPage = lazyWithRetry(() => import('./pages/legal/PromotionsPage'));
const FairGamingPage = lazyWithRetry(() => import('./pages/legal/FairGamingPage'));
const PrivacyPolicyPage = lazyWithRetry(() => import('./pages/legal/PrivacyPolicyPage'));

// Admin Singletons
const EngineDashboard = lazyWithRetry(() => import('./pages/admin/EngineDashboard'));
const AnalyticsDashboard = lazyWithRetry(() => import('./pages/admin/AnalyticsDashboard'));

// Loading fallback
function LoadingSpinner() {
  return (
    <div className="loading-container">
      <div className="spinner" />
      <p style={{ marginTop: '1rem', color: 'var(--text-secondary)' }}>Loading...</p>
    </div>
  );
}

/**
 * Dan 2026-08-19: /table/:tableId only CLAIMS the path (and keeps AuthGuard's
 * redirect for unauthenticated deep links). The actual multi-table UI is
 * mounted once by <PersistentTableLayer /> beside <Routes>, so navigating
 * anywhere else hides it with display:none instead of unmounting it — live
 * engine sockets survive every route change.
 */
function TableRouteSurface() {
  return null;
}

// Imported from centralized storage keys
import { STORAGE_KEYS } from './lib/storage';
import { reportError } from './utils/errorReporter';

export default function App() {
  // Check if intro video has been shown this session
  // DISABLED — intro video turned off. To re-enable, restore the original useState initializer.
  const [showIntro, setShowIntro] = useState(false);

  const handleIntroComplete = () => {
    sessionStorage.setItem(STORAGE_KEYS.INTRO_SHOWN, 'true');
    setShowIntro(false);
  };

  // Offline/Online detection
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const goOffline = () => setIsOffline(true);
    const goOnline = () => {
      setIsOffline(false);
      // Replay queued mutations on reconnect
      OfflineQueueService.replayQueue().catch((err) =>
        console.warn('[App] Offline queue replay error:', err)
      );
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
  // AUTH: Native same-origin session via shared Supabase localStorage key.
  // No postMessage handshake needed — World Hub and Club Arena share
  // the 'smarter-poker-auth' localStorage key on the same domain.
  // IdentityDNA handles session loading via onAuthStateChange listener.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Clean up realtime subscriptions on page unload ──
  // Prevents memory leaks and orphaned connections when user navigates away
  useEffect(() => {
    const handleBeforeUnload = () => {
      try {
        realtimeChannelService
          .unsubscribeAll()
          .catch((err) => console.warn('[App] Cleanup error:', err));
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
    // HARDENED: Force update check every time to bust stale SW caches after re-deploy
    if ('serviceWorker' in navigator) {
      const swPath =
        import.meta.env.BASE_URL && import.meta.env.BASE_URL !== '/'
          ? `${import.meta.env.BASE_URL}sw-bus.js`
          : '/sw-bus.js';
      navigator.serviceWorker
        .register(swPath)
        .then((reg) => {
          // Force the browser to check for a new version of the SW immediately.
          // If sw-bus.js has changed (e.g., DEPLOY_TS updated), the browser will
          // install the new SW, which triggers activate → clears old caches.
          reg.update().catch(() => {});
        })
        .catch((err) => console.warn('[App] Service worker registration failed:', err));
    }

    // Boot all engine services
    bootServices().catch((err) => {
      reportError(err, 'App.Service_bootstrap_failed');
    });

    // Preload critical page chunks during idle time so they're cached
    // for instant re-entry when navigating back from the World Hub
    preloadCriticalChunks();

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
        <ChallengeToastListener />
        <GlobalBalanceSync />
        <LastClubTracker />
        <BusToastBridge />
        <ConfirmHost />
        {/* Dan 2026-08-18: Session Complete now pops in the LOBBY, so its host
          lives outside <Routes> - it has to survive the navigate() off the
          table, and "the lobby" is HomePage OR ClubHomePage (which now serves
          /clubs/:clubId and /clubs/:clubId/lobby alike). */}
        <SessionSummaryHost />
        {/* Dan 2026-08-20: the tournament bust card. Same feed as the cash
          summary above, split on payload.tournament — see TournamentRankingHost. */}
        <TournamentRankingHost />
        {/* Dan 2026-08-20: "when a scheduled MTT is about to start... 5 minutes
          left, there should be a scrolling announcement across all active
          club/union cash games and tournaments." It has to reach players where
          they already are, so it rides at the app root over every page. */}
        <TournamentStartingTicker />
        {/* Dan 2026-08-21: when an MTT starts, the player's seat opens itself. */}
        <TournamentAutoSeat />
        <MilestoneToast />
        <ConnectionStatusBar />
        {/* Accessibility: Skip to main content link */}
        <a href="#main-content" className="skip-link">
          Skip To Main Content
        </a>

        {/* Intro video overlay - app loads in background while video plays */}
        {showIntro && (
          <Suspense fallback={null}>
            <IntroVideo
              videoSrc={`${MEDIA_BASE}videos/club-arena-intro.mp4`}
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
              Reconnecting - Your Actions Are Saved And Will Sync Automatically
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
              <Route path="/replay" element={<SharedHandReplayPage />} />

              {/* Scenario Sim — deterministic UI regression playback, no auth */}
              <Route path="/sim" element={<SimPage />} />

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

              {/* Table — Standalone without AppLayout shell (full-screen immersive).
                  Renders null: PersistentTableLayer (sibling of <Routes>)
                  draws the tables so they survive every route change. */}
              <Route
                path="table/:tableId"
                element={
                  <AuthGuard>
                    <RouteErrorBoundary>
                      <TableRouteSurface />
                    </RouteErrorBoundary>
                  </AuthGuard>
                }
              />

              {/* Protected routes with AppLayout shell — RouteErrorBoundary on each */}
              <Route element={<AppLayout />}>
                {/* RouteErrorBoundary wraps all AppLayout children */}

                {/* ── /clubs IS THE OLD LOBBY. IT IS GONE. ──────────────────
                   Dan 2026-08-23: "any time there experiences a crash, and you
                   click back, you get brought to this page which i believe is a
                   very old and rough club arena lobby. this needs to be 100%
                   removed and deleted and never allowed to be seen or displayed
                   again."

                   ClubCarouselPage was a SECOND lobby, predating the one on
                   `/`. It rendered clubs as generic bank glyphs instead of their
                   card art, had no ACTIVE stat at all, and computed level from a
                   different code path - so it could and did disagree with the
                   real lobby about the same club. Nothing linked to it
                   deliberately any more; it was reached by history, by a crash
                   recovery landing on the previous entry, and by nine stale
                   `/clubs` links scattered around the app.

                   Deleting the component alone would only turn those into a
                   blank route, so the path REDIRECTS. That is what makes the
                   page unreachable by any means - old link, bookmark, back
                   button after a crash - rather than merely unused. The file
                   and its stylesheet are deleted in this commit; the guard test
                   in tests/unit/deadLobbyIsGone.test.ts fails if either the
                   route or the component comes back. */}
                <Route path="clubs" element={<Navigate to="/" replace />} />
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
                      <PageErrorBoundary pageName="Club Data">
                        <ClubDataPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/dashboard-full"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Club Dashboard">
                        <ClubDashboard />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                {/* ONE LOBBY (2026-08-23). This route rendered ClubLobby: a
                    second, 820-line club lobby with its own inline cards, its
                    own filters and its own realtime, for the same club the
                    canonical Lobby V2 at /clubs/:clubId already serves. Two
                    implementations of one screen is the parallel system the
                    Lobby V2 spec forbids, and it was the last surface still
                    shipping the retired card look after PR #313.

                    ClubHomePage reads :clubId from the route, so it renders
                    here unchanged - every existing link (QuickActionsBar, the
                    club dashboard, the table's back-navigation) keeps working
                    and now lands on the same lobby as everything else. */}
                <Route
                  path="clubs/:clubId/lobby"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Club Lobby">
                        <ClubHomePage />
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
                {/*
                  The union lead's side of the weekly square-up. Separate from
                  settlement because settlement moves chips and this does not:
                  this is the billing record, who was billed, who was told, and
                  - the part a per-club view structurally cannot show - who was
                  missed.
                */}
                <Route
                  path="unions/:unionId/statements"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Union Statements">
                        <UnionStatementsPage />
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
                  path="challenges"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Daily Challenges">
                        <DailyChallengesPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
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
                        <MessagesPage />
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
                {/* Club Data is the owner-facing money view: what the club
                    generated and what it owes the union. The older multi-tab
                    dashboard stays reachable at clubs/:clubId/dashboard-full. */}
                <Route
                  path="data"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Club Data">
                        <ClubDataPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/data"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Club Data">
                        <ClubDataPage />
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
                {/* Dan 2026-08-21: the PokerBros-style Trade cashier is now the
                    front door; the full classic cashier (buy-in / cash-out /
                    mint / history) moved to /cashier-classic and is linked
                    from inside the Trade view. */}
                <Route
                  path="clubs/:clubId/cashier"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Cashier">
                        <CashierTradePage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/cashier-classic"
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
                  path="clubs/:clubId/blacklist"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Blacklist Manager">
                        <BlacklistManagerPage />
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

                {/* Health Check — public, no AuthGuard (for uptime monitors) */}
                <Route
                  path="health"
                  element={
                    <PageErrorBoundary pageName="HealthCheck">
                      <HealthCheckPage />
                    </PageErrorBoundary>
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
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        minHeight: '80vh',
                        color: 'var(--off-white, #E4E6EB)',
                        textAlign: 'center',
                        padding: '2rem',
                      }}
                    >
                      <div
                        style={{
                          fontSize: '6rem',
                          fontWeight: 800,
                          lineHeight: 1,
                          background: 'linear-gradient(135deg, #1877F2 0%, #00d4ff 100%)',
                          WebkitBackgroundClip: 'text',
                          WebkitTextFillColor: 'transparent',
                          marginBottom: '0.5rem',
                        }}
                      >
                        404
                      </div>
                      <p
                        style={{
                          fontSize: '1.25rem',
                          color: 'var(--soft-white, #B0B3B8)',
                          marginBottom: '2rem',
                        }}
                      >
                        This Page Doesn't Exist
                      </p>
                      <Link
                        to="/"
                        style={{
                          padding: '12px 32px',
                          background: 'linear-gradient(135deg, #1877F2 0%, #0D5DC7 100%)',
                          color: '#fff',
                          borderRadius: 12,
                          fontWeight: 600,
                          fontSize: '1rem',
                          textDecoration: 'none',
                          transition: 'transform 0.2s ease, box-shadow 0.2s ease',
                          boxShadow: '0 4px 12px rgba(24, 119, 242, 0.3)',
                        }}
                      >
                        Back To Home
                      </Link>
                    </div>
                  }
                />
              </Route>
            </Routes>
          </Suspense>
          {/* Persistent multi-table layer — mounted BESIDE <Routes>, it never
              unmounts on navigation: engine sockets for seated tables survive
              every route. Off /table/* it collapses to display:none and
              surfaces the global resume/action dock instead. */}
          <PersistentTableLayer />
        </TOSGuard>
      </ToastProvider>
    </ErrorBoundary>
  );
}
