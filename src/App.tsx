/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — App Component
 * ═══════════════════════════════════════════════════════════════════════════════
 * Smarter Poker Platform
 * Root application with routing, auth guards, and global providers
 */

import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { SessionSummaryHost } from './components/session/SessionSummaryHost';
import TournamentRankingHost from './components/tournament/TournamentRankingHost';
import TournamentStartingTicker from './components/tournament/TournamentStartingTicker';
import TournamentAutoSeat from './components/tournament/TournamentAutoSeat';
import { MEDIA_BASE } from './utils/mediaBase';
import { Suspense, useState, useEffect } from 'react';
import { supabase } from './lib/supabase';
import { realtimeChannelService } from './services/RealtimeChannelService';
import { OfflineQueueService } from './services/OfflineQueueService';
import GlobalWaitlistListener from './components/common/GlobalWaitlistListener';
import UnionSkinGuard from './components/common/UnionSkinGuard';
import { ChallengeToastListener } from './components/notifications/ChallengeToastListener';
import PushSubscriptionSync from './components/notifications/PushSubscriptionSync';
import FirstRunPushPrompt from './components/notifications/FirstRunPushPrompt';
import LastClubTracker from './components/common/LastClubTracker';
import WaitlistBanner from './components/common/WaitlistBanner';
import { addBreadcrumb } from './core/SentryInit';

// Intro Video — lazy-loaded (only shown once per session, not needed for initial paint)
const IntroVideo = lazyWithRetry(() => import('./components/IntroVideo'));
import { useSettingsStore } from './stores/useSettingsStore';
import { useShellUpdateGate } from './hooks/useShellUpdateGate';
import { startShellTelemetry } from './services/ShellTelemetryService';

// Layouts
import AppLayout from './components/layouts/AppLayout';
import LegacyClubToolRedirect from './components/navigation/LegacyClubToolRedirect';
import { ToastProvider } from './components/common/Toast';
import ErrorBoundary from './components/common/ErrorBoundary';
import RouteErrorBoundary from './components/common/RouteErrorBoundary';
import { PageErrorBoundary } from './components/common/PageErrorBoundary';
import { LoadingState } from './components/common/EmptyState';
import OfflineQueueBadge from './components/common/OfflineQueueBadge';
import NavigationProgress from './components/common/NavigationProgress';
import ConnectionIndicator from './components/common/ConnectionIndicator';
import ConnectionStatusBar from './components/ConnectionStatusBar';
import PersistentTableLayer from './components/table/PersistentTableLayer';
import BusToastBridge from './components/common/BusToastBridge';
import { ConfirmHost } from './components/common/confirmDialog';
import { SignUpHost } from './components/tournament/signUpDialog';
import MilestoneToast from './components/common/MilestoneToast';
import { GlobalBalanceSync } from './core/useGlobalBalanceSync';
import ClubBottomNav from './components/club/ClubBottomNav';
import { shouldShowClubFooterFor } from './components/club/clubFooterVisibility';
import { useInTabLobbyActive } from './components/club/inTabLobbySurface';

// Auth Guards
import { AuthGuard, GuestGuard } from './components/auth/AuthGuard';
import ClubMemberGuard from './components/auth/ClubMemberGuard';
import GameCreationGuard from './components/auth/GameCreationGuard';
import TOSGuard from './components/legal/TOSGuard';
import { lazyWithRetry } from './utils/lazyWithRetry';

// Pages (lazy loaded for performance)
const AuthPage = lazyWithRetry(() => import('./pages/AuthPage'));
const HomePage = lazyWithRetry(() => import('./pages/HomePage'));

const ClubsPage = lazyWithRetry(() => import('./pages/ClubsPage'));
const ClubHomePage = lazyWithRetry(() => import('./pages/ClubHomePage'));
const ClubDashboard = lazyWithRetry(() => import('./pages/club/ClubDashboard'));
const ClubDataPage = lazyWithRetry(() => import('./pages/club/ClubDataPage'));
const ClubOperationsPage = lazyWithRetry(() => import('./pages/club/ClubOperationsPage'));
const CreateTablePage = lazyWithRetry(() => import('./pages/CreateTablePage'));
const TableConfigPage = lazyWithRetry(() => import('./pages/TableConfigPage'));
const GameManagementPage = lazyWithRetry(() => import('./pages/GameManagementPage'));
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
const UnionDataPage = lazyWithRetry(() => import('./pages/UnionDataPage'));
const CreateUnionPage = lazyWithRetry(() => import('./pages/CreateUnionPage'));
// Lazy like the page it wraps: it is only ever needed on /unions/create.
const UnionCreationGuard = lazyWithRetry(() => import('./components/auth/UnionCreationGuard'));
const SettlementPage = lazyWithRetry(() => import('./pages/SettlementPage'));

// New Pages
const LeaderboardPage = lazyWithRetry(() => import('./pages/LeaderboardPage'));
const HandHistoryPage = lazyWithRetry(() => import('./pages/HandHistoryPage'));
const PlayerWalletPage = lazyWithRetry(() => import('./pages/PlayerWalletPage'));
const NotificationsPage = lazyWithRetry(() => import('./pages/NotificationsPage'));
const NavigateToMessenger = lazyWithRetry(() => import('./pages/NavigateToMessenger'));
const SearchPage = lazyWithRetry(() => import('./pages/SearchPage'));
const HelpPage = lazyWithRetry(() => import('./pages/HelpPage'));
const CashierPage = lazyWithRetry(() => import('./pages/CashierPage'));
const CashierTradePage = lazyWithRetry(() => import('./pages/CashierTradePage'));
const SuperAgentDashboard = lazyWithRetry(() => import('./pages/SuperAgentDashboard'));
const AchievementsPage = lazyWithRetry(() => import('./pages/AchievementsPage'));
const ClubMembersPage = lazyWithRetry(() => import('./pages/ClubMembersPage'));
const MemberManagementPage = lazyWithRetry(() => import('./pages/MemberManagementPage'));
const PlayerStatisticsPage = lazyWithRetry(() => import('./pages/PlayerStatisticsPage'));
const PromoVaultPage = lazyWithRetry(() => import('./pages/PromoVaultPage'));
const FriendsPage = lazyWithRetry(() => import('./pages/FriendsPage'));
const RakebackPage = lazyWithRetry(() => import('./pages/RakebackPage'));
const BadBeatJackpotPage = lazyWithRetry(() => import('./pages/BadBeatJackpotPage'));
const PlayerStatsPage = lazyWithRetry(() => import('./pages/PlayerStatsPage'));
const PromotionsPage = lazyWithRetry(() => import('./pages/PromotionsPage'));
const ClubSettingsPage = lazyWithRetry(() => import('./pages/ClubSettingsPage'));
const TransactionHistoryPage = lazyWithRetry(() => import('./pages/TransactionHistoryPage'));
const InvitePage = lazyWithRetry(() => import('./pages/InvitePage'));
const NotFoundPage = lazyWithRetry(() => import('./pages/NotFoundPage'));
const ReportPlayerPage = lazyWithRetry(() => import('./pages/ReportPlayerPage'));
const ReportReviewPage = lazyWithRetry(() => import('./pages/ReportReviewPage'));
// INSURANCE REPORT 2026-08-28: staff-facing funnel + P&L for all-in insurance.
const ClubInsuranceReportPage = lazyWithRetry(() => import('./pages/club/ClubInsuranceReportPage'));
const ClubBombPotReportPage = lazyWithRetry(() => import('./pages/club/ClubBombPotReportPage'));
const TableBombSettingsPage = lazyWithRetry(() => import('./pages/club/TableBombSettingsPage'));
const ClubAnnouncementsPage = lazyWithRetry(() => import('./pages/ClubAnnouncementsPage'));
const VIPPage = lazyWithRetry(() => import('./pages/VIPPage'));
const ClubFinancialsPage = lazyWithRetry(() => import('./pages/ClubFinancialsPage'));
const BonusPage = lazyWithRetry(() => import('./pages/BonusPage'));
const ClubRulesPage = lazyWithRetry(() => import('./pages/ClubRulesPage'));
const NotificationCenter = lazyWithRetry(() => import('./pages/NotificationCenter'));
const BusDevToolsPage = lazyWithRetry(() => import('./pages/BusDevToolsPage'));
const ClubButtonsShowcasePage = lazyWithRetry(() => import('./pages/dev/ClubButtonsShowcasePage'));
const ClubWalletPreviewPage = lazyWithRetry(() => import('./pages/dev/ClubWalletPreviewPage'));
const ArenaGameCardsShowcasePage = lazyWithRetry(
  () => import('./pages/dev/ArenaGameCardsShowcasePage')
);
const ClubFooterShowcasePage = lazyWithRetry(() => import('./pages/dev/ClubFooterShowcasePage'));
const CustomizationStudioShowcasePage = lazyWithRetry(
  () => import('./pages/dev/CustomizationStudioShowcasePage')
);
const FinancialDecisionShowcasePage = lazyWithRetry(
  () => import('./pages/dev/FinancialDecisionShowcasePage')
);
const clubButtonsPreviewEnabled = import.meta.env.VITE_CLUB_BUTTONS_PREVIEW === 'true';
const customizationHarnessEnabled =
  import.meta.env.DEV || import.meta.env.VITE_CUSTOMIZATION_TEST_HARNESS === 'true';
const financialDecisionHarnessEnabled =
  import.meta.env.DEV || import.meta.env.VITE_FINANCIAL_DECISION_TEST_HARNESS === 'true';
const FinancialAlertsPage = lazyWithRetry(() => import('./pages/FinancialAlertsPage'));
const DisputeManagementPage = lazyWithRetry(() => import('./pages/DisputeManagementPage'));
const FinancialHealthPage = lazyWithRetry(() => import('./pages/FinancialHealthPage'));
const DriftIncidentsPage = lazyWithRetry(() => import('./pages/DriftIncidentsPage'));
const FinancialAdminHub = lazyWithRetry(() => import('./pages/FinancialAdminHub'));
const RateAuditPage = lazyWithRetry(() => import('./pages/RateAuditPage'));
const SettlementDashboardPage = lazyWithRetry(() => import('./pages/SettlementDashboardPage'));
const AgentPortalPage = lazyWithRetry(() => import('./pages/AgentPortalPage'));
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
const AgentDashboardPage = lazyWithRetry(() => import('./pages/AgentDashboardPage'));
const UnionDashboardPage = lazyWithRetry(() => import('./pages/UnionDashboardPage'));
const CommunityWorkspacePage = lazyWithRetry(() =>
  import('./pages/workspaces/ArenaWorkspacePages').then((module) => ({
    default: module.CommunityWorkspacePage,
  }))
);
const PlayWorkspacePage = lazyWithRetry(() =>
  import('./pages/workspaces/ArenaWorkspacePages').then((module) => ({
    default: module.PlayWorkspacePage,
  }))
);
const RewardsWorkspacePage = lazyWithRetry(() =>
  import('./pages/workspaces/ArenaWorkspacePages').then((module) => ({
    default: module.RewardsWorkspacePage,
  }))
);
const LegalWorkspacePage = lazyWithRetry(() =>
  import('./pages/workspaces/ArenaWorkspacePages').then((module) => ({
    default: module.LegalWorkspacePage,
  }))
);
const ClubFinanceWorkspacePage = lazyWithRetry(() =>
  import('./pages/workspaces/ArenaWorkspacePages').then((module) => ({
    default: module.ClubFinanceWorkspacePage,
  }))
);
const ClubControlWorkspacePage = lazyWithRetry(() =>
  import('./pages/workspaces/ArenaWorkspacePages').then((module) => ({
    default: module.ClubControlWorkspacePage,
  }))
);

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
/* House ads: smarter.poker's own promotions, platform-staff only. The page
   gates on profiles.role and the API route behind it checks again. */
const HouseAdsPage = lazyWithRetry(() => import('./pages/admin/HouseAdsPage'));

// Loading fallback
function LoadingSpinner() {
  return <LoadingState message="Preparing Club Arena" />;
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
import SlugEnforcer from './components/common/SlugEnforcer';

function ClubFooterMount() {
  return <ClubBottomNav />;
}

/** The footer probe must stay outside auth, TOS, realtime, and data providers.
 * It is used by CI and the post-deploy monitor to prove the shipped footer in
 * a clean Safari/WebKit context, even when Supabase is slow or unavailable. */
function ClubFooterProbe() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <ClubFooterShowcasePage />
      </Suspense>
      <ClubFooterMount />
    </ErrorBoundary>
  );
}

function FullApp() {
  const location = useLocation();
  const inTabLobbyActive = useInTabLobbyActive();
  /* The listener the service worker has always been posting SHELL_UPDATED to
     and never had. Without it a cache-first shell — and the exact hashed
     chunks it names — is served for the life of the session, so a player can
     run a days-old bundle while production serves the fix. Applies the update
     only away from a table and only with the tab visible; see the hook. */
  useShellUpdateGate();
  /* And the reader for what that gate emits (2026-08-30). The gate has been
     publishing SHELL_STALENESS_CHECKED / SHELL_RELOADED since 2026-08-29 with
     nothing subscribed — the same shape as SHELL_UPDATED itself, which was
     posted for months to a client that had no handler. This fix is INVISIBLE
     when it works (no reload happens), so without a sink there is no way to
     tell "holding" from "quietly broken". Idempotent; see the service. */
  useEffect(() => {
    startShellTelemetry();
  }, []);

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
    let disposed = false;

    // PERF 2026-08-24. Every module started below runs AFTER first paint, and
    // every one of them was a STATIC import at the top of this file — so its
    // whole dependency tree was welded into the entry chunk and had to be
    // downloaded, parsed and evaluated BEFORE the lobby could paint. That is
    // how SettlementCronService and FinancialCronService, neither of which the
    // lobby has any use for, ended up on the critical path of every boot.
    //
    // Importing them here instead is behaviour-neutral (they already only ran
    // from this effect) and takes them out of the first paint entirely.
    const deferred = Promise.all([
      import('./services/BusEventLogger'),
      import('./utils/supabaseConnectionWatchdog'),
      import('./services/ServiceBootstrap'),
      import('./utils/ChunkPreloader'),
    ])
      .then(([logger, watchdog, bootstrap, preloader]) => {
        // Unmounted while the chunks were in flight: start nothing, so the
        // cleanup below has nothing to tear down.
        if (disposed) return null;

        logger.busEventLogger.start();

        // Start Supabase connection watchdog (monitors connectivity, emits bus
        // events, auto-reconnects realtime channels on recovery)
        watchdog.supabaseConnectionWatchdog.start();

        // Boot all engine services
        bootstrap.bootServices().catch((err) => {
          reportError(err, 'App.Service_bootstrap_failed');
        });

        // Preload critical page chunks during idle time so they're cached
        // for instant re-entry when navigating back from the World Hub
        preloader.preloadCriticalChunks();

        return { logger, watchdog, bootstrap };
      })
      .catch((err) => {
        reportError(err, 'App.Deferred_service_start_failed');
        return null;
      });

    // ── Register the service worker ────────────────────────────────────────
    //
    // SCOPE, 2026-08-24. This registered `/hub/club-arena/sw-bus.js` with no
    // scope option, so it took the default: the script's own directory,
    // `/hub/club-arena/` — WITH the trailing slash. Scope matching is a plain
    // string prefix, and `/hub/club-arena/` is not a prefix of
    // `/hub/club-arena`. That bare URL is exactly what the World Hub tile
    // links to and what the SPA fallback rewrite serves, so the single most
    // common way into this app produced an UNCONTROLLED page: no precached
    // shell, no cache-first chunks, no media cache. Every one of those
    // optimisations was live in the file and reached nobody who arrived by
    // the front door. Deep links (/hub/club-arena/clubs/x) were in scope,
    // which is why it looked like it worked when tested.
    //
    // Asking for `/hub/club-arena` covers the bare URL and everything under
    // it. That is wider than the script's directory, so the server must say
    // `Service-Worker-Allowed: /hub/club-arena` (World Hub vercel.json). If
    // that header is ever absent the registration rejects with a SecurityError
    // — we fall back to the default scope so behaviour is never worse than it
    // was, rather than ending up with no service worker at all.
    if ('serviceWorker' in navigator) {
      const base =
        import.meta.env.BASE_URL && import.meta.env.BASE_URL !== '/'
          ? import.meta.env.BASE_URL
          : '/';
      const swPath = `${base}sw-bus.js`;
      // BASE_URL carries a trailing slash; the scope must not, or we are back
      // to the bug above.
      const wideScope = base.length > 1 ? base.replace(/\/$/, '') : '/';

      const afterRegister = (reg: ServiceWorkerRegistration) => {
        // Force the browser to check for a new version of the SW immediately.
        // If sw-bus.js has changed (e.g., DEPLOY_TS updated), the browser will
        // install the new SW, which triggers activate → clears old caches.
        reg.update().catch(() => {});
      };

      navigator.serviceWorker
        .register(swPath, { scope: wideScope })
        .then(afterRegister)
        .catch(() =>
          navigator.serviceWorker
            .register(swPath)
            .then(afterRegister)
            .catch((err) => console.warn('[App] Service worker registration failed:', err))
        );
    }

    return () => {
      disposed = true;
      // Tear down whatever actually started. If the chunks never resolved, or
      // resolved after unmount, `deferred` is null and there is nothing to do.
      deferred
        .then((mods) => {
          if (!mods) return;
          mods.logger.busEventLogger.stop();
          mods.watchdog.supabaseConnectionWatchdog.stop();
          // Tear down engine services (online listener, cron timer, IndexedDB)
          mods.bootstrap.shutdownServices();
        })
        .catch(() => {});
    };
  }, []);

  return (
    <ErrorBoundary>
      <ToastProvider>
        <ChallengeToastListener />
        {/* Web push enrolment. Club Arena had no path to a push subscription at
          all until 2026-08-27: the prompt lived in the World Hub's _app.js,
          which this SPA never loads, so 2,432 seat offers in seven days were
          skipped for `no_subscription` against 2 subscribed accounts platform
          wide. Both mount at the root because neither belongs to a route: the
          sync repairs a rotated subscription on any page, and the prompt has
          to be able to appear wherever the player actually is. See
          src/lib/pushClient.ts for why enrolment targets the ROOT service
          worker and not Club Arena's own sw-bus.js. */}
        <PushSubscriptionSync />
        <FirstRunPushPrompt />
        <GlobalBalanceSync />
        <LastClubTracker />
        {/* Dan 2026-08-23, binding: "players, agents, super agents, nobody
          should ever see the union skins." A union is a `clubs` row, so every
          /clubs/:clubId/* route will render it through the club chrome. The
          links that did so are fixed at source; this is the backstop for a
          bookmark, a shared URL, or the next feature to make the same mistake.
          Owner and union admins pass through. */}
        <UnionSkinGuard />
        <BusToastBridge />
        <ConfirmHost />
        {/* Dan 2026-08-25: the ONE tournament buy-in confirmation. Mounted here
          for the same reason ConfirmHost is - every register button in the app
          goes through useTournamentRegistration, which awaits this imperatively,
          and it must be reachable from the club lobby, the tournament page, XMTT
          and union games alike, not only from the tournament details route. */}
        <SignUpHost />
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
              role="status"
              aria-live="polite"
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
            <SlugEnforcer />
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

              {/* Approved footer visual harness — intentionally blank except
                  for the one application-root footer mounted below Routes. */}
              <Route path="/dev/footer" element={<ClubFooterShowcasePage />} />

              {/* Real-component browser harness. Development/test builds only;
                  production navigation cannot expose the deterministic user. */}
              <Route
                path="/dev/customization"
                element={
                  customizationHarnessEnabled ? (
                    <CustomizationStudioShowcasePage />
                  ) : (
                    <Navigate to="/" replace />
                  )
                }
              />

              {/* Real insurance and Rabbit Hunt components, driven by a
                  deterministic no-money backend. The route is unavailable in
                  normal production builds. */}
              <Route
                path="/dev/financial-decisions"
                element={
                  financialDecisionHarnessEnabled ? (
                    <FinancialDecisionShowcasePage />
                  ) : (
                    <Navigate to="/" replace />
                  )
                }
              />

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
                    <PageErrorBoundary pageName="Table">
                      <TableRouteSurface />
                    </PageErrorBoundary>
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

                {/* CreateClubPage was deleted with the modal redesign, but
                    old links (hamburger menu, CreateUnionPage, bookmarks)
                    still pointed here — and without this redirect they fell
                    through to clubs/:clubId with clubId="create", a club
                    that does not exist. The lobby opens CreateClubModal
                    when it sees ?create=club. */}
                <Route path="clubs/create" element={<Navigate to="/?create=club" replace />} />

                <Route
                  path="clubs/:clubId"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Club Home">
                          <ClubHomePage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/agents"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Agent Management">
                          <AgentManagementPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/create-table"
                  element={
                    <AuthGuard>
                      <GameCreationGuard>
                        <PageErrorBoundary pageName="Create Table">
                          <CreateTablePage />
                        </PageErrorBoundary>
                      </GameCreationGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/table-management"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Table Management">
                          <GameManagementPage scope="club" />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/create-table/:gameType"
                  element={
                    <AuthGuard>
                      <GameCreationGuard>
                        <PageErrorBoundary pageName="Table Config">
                          <TableConfigPage />
                        </PageErrorBoundary>
                      </GameCreationGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/dashboard"
                  /* TWO URLS, ONE PAGE (Phase 7).
                     This rendered exactly the same ClubDataPage as
                     clubs/:clubId/data, which the operations rail links. The
                     allowlist called it "superseded by dashboard-full", which
                     was never what it rendered. `relative="path"` resolves
                     ../data against the current URL, so the club id follows
                     without a component to carry it. */
                  element={<Navigate to="../data" relative="path" replace />}
                />
                <Route
                  path="clubs/:clubId/operations"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Club Operations">
                          <ClubOperationsPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/finance"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Finance And Risk">
                          <ClubFinanceWorkspacePage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/control"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Club Control">
                          <ClubControlWorkspacePage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/dashboard-full"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Club Dashboard">
                          <ClubDashboard />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
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
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Club Lobby">
                          <ClubHomePage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/tournaments"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Tournaments">
                          <TournamentPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/messages"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Messages">
                          <NavigateToMessenger />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
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
                <Route path="tournament-lobby" element={<Navigate to="/tournaments" replace />} />
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
                        <LegacyClubToolRedirect destination="agents" toolName="Agent Management" />
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
                      <UnionCreationGuard>
                        <PageErrorBoundary pageName="Create Union">
                          <CreateUnionPage />
                        </PageErrorBoundary>
                      </UnionCreationGuard>
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
                  path="unions/:unionId/operations"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Union Operations">
                        <UnionDashboardPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="unions/:unionId/table-management"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Union Table Management">
                        <GameManagementPage scope="union" />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                {/*
                  What the union PRODUCED, as against what it billed. The rake
                  snapshot could always answer the union question, but only
                  from inside a member club - so a union lead who owns no club
                  had no door to it, and one who owns two had to pick a club
                  and hope the figure above it was the union's.

                  No ClubMemberGuard here, deliberately: the whole point is a
                  union lead who is not a member of any club in it. The RPC is
                  gated on ca_can_oversee_union and raises on its own.
                */}
                <Route
                  path="unions/:unionId/data"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Union Data">
                        <UnionDataPage />
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
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Settlement">
                          <SettlementPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
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
                  path="play"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Play And Review">
                        <PlayWorkspacePage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
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
                <Route path="history" element={<Navigate to="/hand-history" replace />} />
                <Route
                  path="rewards"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Rewards Center">
                        <RewardsWorkspacePage />
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
                  path="community"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Community Center">
                        <CommunityWorkspacePage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="messages"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Messages">
                        <NavigateToMessenger />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="messages/new"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="New Message">
                        <NavigateToMessenger />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="messages/:conversationId"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Messages">
                        <NavigateToMessenger />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="messages/clubs"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Club Messages">
                        <NavigateToMessenger />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="messages/clubs/:conversationId"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Club Messages">
                        <NavigateToMessenger />
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
                        <LegacyClubToolRedirect destination="members" toolName="Players" />
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
                        <LegacyClubToolRedirect destination="data" toolName="Club Data" />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/data"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Club Data">
                          <ClubDataPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
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
                  /* CLUB PLAYER OPERATIONS ARE CLUB-SCOPED (Phase 7).
                     PlayerSessionsPage was a global, unparameterised twin of
                     clubs/:clubId/members with no door. It resolved a club for
                     itself, which is exactly what LegacyClubToolRedirect does
                     for the other four legacy operator URLs - so it joins them
                     rather than keeping a second answer to the same question. */
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Players">
                        <LegacyClubToolRedirect destination="members" toolName="Players" />
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
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Cashier">
                          <CashierTradePage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/cashier-classic"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Cashier">
                          <CashierPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
                    </AuthGuard>
                  }
                />
                <Route path="hands" element={<Navigate to="/hand-history" replace />} />
                <Route
                  path="clubs/:clubId/agent-dashboard"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Super Agent Dashboard">
                          <SuperAgentDashboard />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
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
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Club Members">
                          <ClubMembersPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/promo-vault"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Promo Vault">
                          <PromoVaultPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/members/:userId"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Member Management">
                          <MemberManagementPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/members/:userId/statistics"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Player Statistics">
                          <PlayerStatisticsPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
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
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Bad Beat Jackpot">
                          <BadBeatJackpotPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
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
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Promotions">
                          <PromotionsPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/settings"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Club Settings">
                          <ClubSettingsPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
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
                        <LegacyClubToolRedirect destination="invite" toolName="Club Invite" />
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
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Report Review">
                          <ReportReviewPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/insurance-report"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Insurance Report">
                          <ClubInsuranceReportPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/tables/:tableId/bomb-settings"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Table Bomb Settings">
                          <TableBombSettingsPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/bomb-pot-report"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Bomb Pot Report">
                          <ClubBombPotReportPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/announcements"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Announcements">
                          <ClubAnnouncementsPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
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
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Club Financials">
                          <ClubFinancialsPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
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
                  path="financial-incidents"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Drift Incidents">
                        <DriftIncidentsPage />
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
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Disputes">
                          <DisputeManagementPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
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
                  /* ONE RAKEBACK DISPLAY (Phase 7, Dan 2026-08-31).
                     RakebackDashboard was a second player-facing rakeback view
                     beside /rakeback, reachable only by typing the URL. Same
                     ruling as notification-center on 2026-08-25: one display
                     per thing. Kept as a redirect so bookmarks still land. */
                  element={<Navigate to="/rakeback" replace />}
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
                  /* THE WAITLIST LIVES WHERE THE TABLES ARE (Phase 7).
                     table_waitlist carries 10,055 rows, every one of them put
                     there by the lobby and table flow. This standalone page was
                     a second view of the same queue that nothing linked to.
                     Redirected to the arena, where the tables and their queues
                     actually are. */
                  element={<Navigate to="/" replace />}
                />
                <Route
                  path="clubs/:clubId/blacklist"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Blacklist Manager">
                          <BlacklistManagerPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/rules"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Club Rules">
                          <ClubRulesPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
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

                {/* Q4: Backported Pages (Hub → Club Arena) */}
                <Route
                  path="anti-cheat"
                  /* The legacy global entrance. Anti-cheat is club-owned data,
                     so it now has a club-scoped route below and a door on the
                     operations rail. This one resolves a club and forwards,
                     exactly as the four other legacy operator URLs do. */
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="Anti-Cheat">
                        <LegacyClubToolRedirect destination="anti-cheat" toolName="Anti-Cheat" />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
                <Route
                  path="clubs/:clubId/anti-cheat"
                  element={
                    <AuthGuard>
                      <ClubMemberGuard>
                        <PageErrorBoundary pageName="Anti-Cheat">
                          <AntiCheatPage />
                        </PageErrorBoundary>
                      </ClubMemberGuard>
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
                  /* THE SAME PAGE, WITHOUT ITS UNION (Phase 7).
                     UnionDashboardPage serves at /unions/:unionId/operations and
                     is reachable there. This was the unparameterised twin: it
                     guessed a union for itself and nothing linked to it. Its
                     3,130 lines were never invisible - only this door was. */
                  element={<Navigate to="/unions" replace />}
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
                  /* THE SAME PAGE, WITHOUT ITS UNION (Phase 7).
                     UnionGamesPage serves at /unions/:unionId/games and is
                     reachable there. Same unparameterised twin as
                     union-dashboard above. */
                  element={<Navigate to="/unions" replace />}
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
                <Route
                  path="dev/club-ui"
                  element={
                    clubButtonsPreviewEnabled ? (
                      <PageErrorBoundary pageName="Club Wallet Preview">
                        <ClubWalletPreviewPage />
                      </PageErrorBoundary>
                    ) : (
                      <AuthGuard>
                        <PageErrorBoundary pageName="ClubButtons UI Laboratory">
                          <ClubButtonsShowcasePage />
                        </PageErrorBoundary>
                      </AuthGuard>
                    )
                  }
                />
                <Route
                  path="dev/game-cards"
                  element={
                    clubButtonsPreviewEnabled ? (
                      <PageErrorBoundary pageName="Arena Game Card Preview">
                        <ArenaGameCardsShowcasePage />
                      </PageErrorBoundary>
                    ) : (
                      <AuthGuard>
                        <PageErrorBoundary pageName="Arena Game Card Laboratory">
                          <ArenaGameCardsShowcasePage />
                        </PageErrorBoundary>
                      </AuthGuard>
                    )
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
                  path="legal"
                  element={
                    <PageErrorBoundary pageName="Legal Center">
                      <LegalWorkspacePage />
                    </PageErrorBoundary>
                  }
                />
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
                  path="house-ads"
                  element={
                    <AuthGuard>
                      <PageErrorBoundary pageName="House Ads">
                        <HouseAdsPage />
                      </PageErrorBoundary>
                    </AuthGuard>
                  }
                />
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
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </Suspense>
          {/* Route OR in-tab lobby: the "+" lobby lives on /table/<id>, and the
              footer is owed to the lobby, not to the URL (inTabLobbySurface). */}
          {shouldShowClubFooterFor(location.pathname, inTabLobbyActive) && <ClubFooterMount />}
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

export default function App() {
  const location = useLocation();

  if (location.pathname === '/dev/footer') {
    return <ClubFooterProbe />;
  }

  return <FullApp />;
}
