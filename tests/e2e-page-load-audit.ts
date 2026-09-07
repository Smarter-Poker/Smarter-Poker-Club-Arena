/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  E2E PAGE LOAD AUDIT — Verify every Club Arena page imports & exports correctly
 * ═══════════════════════════════════════════════════════════════════════════════
 * This script dynamically imports every page component and verifies:
 * 1. The file exists and can be imported
 * 2. It has a valid default export (React component)
 * 3. No import-time exceptions are thrown
 *
 * Run: npx tsx tests/e2e-page-load-audit.ts
 */

interface PageTest {
  route: string;
  importPath: string;
}

const ALL_PAGES: PageTest[] = [
  // Auth & Public
  { route: '/auth', importPath: '../src/pages/AuthPage' },
  { route: '/share/hand/:handId', importPath: '../src/pages/share/HandReplayerPage' },

  // Core navigation
  { route: '/', importPath: '../src/pages/HomePage' },
  { route: '/lobby', importPath: '../src/pages/LobbyPage' },
  { route: '/clubs/create', importPath: '../src/pages/CreateClubPage' },
  { route: '/clubs/:clubId', importPath: '../src/pages/ClubHomePage' },
  { route: '/clubs/:clubId/agents', importPath: '../src/pages/AgentManagementPage' },
  { route: '/clubs/:clubId/create-table', importPath: '../src/pages/CreateTablePage' },
  { route: '/clubs/:clubId/create-table/:gameType', importPath: '../src/pages/TableConfigPage' },
  { route: '/clubs/:clubId/dashboard', importPath: '../src/pages/club/ClubDashboard' },
  // ONE LOBBY (2026-08-23): this route renders ClubHomePage now.
  { route: '/clubs/:clubId/lobby', importPath: '../src/pages/ClubHomePage' },
  { route: '/clubs/:clubId/tournaments', importPath: '../src/pages/TournamentPage' },
  { route: '/clubs/:clubId/messages', importPath: '../src/pages/ClubMessagesPage' },

  // Tournaments
  { route: '/tournaments/:tournamentId', importPath: '../src/pages/tournament/TournamentDetails' },
  { route: '/tournament-lobby', importPath: '../src/pages/tournament/TournamentLobbyPage' },
  { route: '/tournaments', importPath: '../src/pages/TournamentPage' },
  { route: '/tournament-results', importPath: '../src/pages/tournament/TournamentResultsPage' },

  // Table
  { route: '/table/:tableId', importPath: '../src/pages/TablePage' },

  // Player pages
  { route: '/profile', importPath: '../src/pages/ProfilePage' },
  { route: '/profile/:userId', importPath: '../src/pages/PublicProfilePage' },
  { route: '/settings', importPath: '../src/pages/SettingsPage' },
  { route: '/leaderboard', importPath: '../src/pages/LeaderboardPage' },
  { route: '/history', importPath: '../src/pages/HandHistoryPage' },
  { route: '/wallet', importPath: '../src/pages/PlayerWalletPage' },
  { route: '/notifications', importPath: '../src/pages/NotificationsPage' },
  { route: '/achievements', importPath: '../src/pages/AchievementsPage' },
  { route: '/friends', importPath: '../src/pages/FriendsPage' },
  { route: '/rakeback', importPath: '../src/pages/RakebackPage' },
  { route: '/stats', importPath: '../src/pages/PlayerStatsPage' },
  { route: '/stats/:userId', importPath: '../src/pages/PlayerStatsPage' },
  { route: '/vip', importPath: '../src/pages/VIPPage' },
  { route: '/transactions', importPath: '../src/pages/TransactionHistoryPage' },
  { route: '/flash-pool', importPath: '../src/pages/FlashPoolPage' },
  { route: '/session-history', importPath: '../src/pages/SessionHistoryPage' },

  // Messaging
  { route: '/messages', importPath: '../src/pages/MessagesPage' },
  { route: '/messages/new', importPath: '../src/pages/NewConversationPage' },
  { route: '/messages/:conversationId', importPath: '../src/pages/MessagesPage' },
  { route: '/messages/clubs', importPath: '../src/pages/ClubMessagesPage' },
  { route: '/messages/clubs/:conversationId', importPath: '../src/pages/ClubMessagesPage' },

  // Search & Help
  { route: '/search', importPath: '../src/pages/SearchPage' },
  { route: '/help', importPath: '../src/pages/HelpPage' },

  // Cashier
  { route: '/cashier', importPath: '../src/pages/CashierPage' },
  { route: '/clubs/:clubId/cashier', importPath: '../src/pages/CashierPage' },

  // Club management
  { route: '/players', importPath: '../src/pages/ClubMembersPage' },
  { route: '/data', importPath: '../src/pages/club/ClubDashboard' },
  { route: '/admin', importPath: '../src/pages/AdminDashboardPage' },
  { route: '/player-sessions', importPath: '../src/pages/PlayerSessionsPage' },
  { route: '/agent-dashboard', importPath: '../src/pages/AgentDashboardPage' },
  { route: '/clubs/:clubId/agent-dashboard', importPath: '../src/pages/AgentDashboardPage' },
  { route: '/clubs/:clubId/members', importPath: '../src/pages/ClubMembersPage' },
  { route: '/clubs/:clubId/settings', importPath: '../src/pages/ClubSettingsPage' },
  { route: '/clubs/:clubId/promotions', importPath: '../src/pages/PromotionsPage' },
  { route: '/clubs/:clubId/announcements', importPath: '../src/pages/ClubAnnouncementsPage' },
  { route: '/clubs/:clubId/jackpot', importPath: '../src/pages/BadBeatJackpotPage' },
  { route: '/clubs/:clubId/financials', importPath: '../src/pages/ClubFinancialsPage' },
  { route: '/clubs/:clubId/reports', importPath: '../src/pages/ReportReviewPage' },
  { route: '/clubs/:clubId/rules', importPath: '../src/pages/ClubRulesPage' },
  { route: '/clubs/:clubId/settlement', importPath: '../src/pages/SettlementPage' },
  { route: '/clubs/:clubId/disputes', importPath: '../src/pages/DisputeManagementPage' },
  { route: '/hands', importPath: '../src/pages/HandHistoryPage' },
  { route: '/promotions', importPath: '../src/pages/PromotionsPage' },

  // Unions
  { route: '/unions', importPath: '../src/pages/UnionsPage' },
  { route: '/unions/create', importPath: '../src/pages/CreateUnionPage' },
  { route: '/unions/:unionId', importPath: '../src/pages/UnionDetailPage' },
  { route: '/unions/:unionId/settlement', importPath: '../src/pages/SettlementPage' },
  { route: '/unions/:unionId/games', importPath: '../src/pages/UnionGamesPage' },
  { route: '/union-games', importPath: '../src/pages/UnionGamesPage' },
  { route: '/union-dashboard', importPath: '../src/pages/UnionDashboardPage' },

  // Financial admin
  { route: '/financial-alerts', importPath: '../src/pages/FinancialAlertsPage' },
  { route: '/disputes', importPath: '../src/pages/DisputeManagementPage' },
  { route: '/financial-health', importPath: '../src/pages/FinancialHealthPage' },
  { route: '/financial-admin', importPath: '../src/pages/FinancialAdminHub' },
  { route: '/rate-audit', importPath: '../src/pages/RateAuditPage' },
  { route: '/settlement-dashboard', importPath: '../src/pages/SettlementDashboardPage' },
  { route: '/settlement-history', importPath: '../src/pages/SettlementHistoryPage' },
  { route: '/agent-portal', importPath: '../src/pages/AgentPortalPage' },
  { route: '/rakeback-dashboard', importPath: '../src/pages/RakebackDashboard' },
  { route: '/credit-admin', importPath: '../src/pages/CreditAdminPanel' },
  { route: '/super-agent', importPath: '../src/pages/SuperAgentDashboard' },

  // Invites & Reports
  { route: '/invite/:clubId', importPath: '../src/pages/InvitePage' },
  { route: '/invite', importPath: '../src/pages/InvitePage' },
  { route: '/report/:playerId', importPath: '../src/pages/ReportPlayerPage' },

  // New pages
  { route: '/notification-center', importPath: '../src/pages/NotificationCenter' },
  { route: '/clubs-list', importPath: '../src/pages/ClubsPage' },
  { route: '/anti-cheat', importPath: '../src/pages/AntiCheatPage' },
  { route: '/xmtt', importPath: '../src/pages/XMTTPage' },
  { route: '/marketplace', importPath: '../src/pages/MarketplacePage' },
  { route: '/waitlist', importPath: '../src/pages/WaitlistPage' },
  { route: '/agent-management', importPath: '../src/pages/AgentManagementPage' },

  // Dev / Legal / Admin
  { route: '/dev/bus', importPath: '../src/pages/BusDevToolsPage' },
  { route: '/legal/tos', importPath: '../src/pages/legal/TermsOfServicePage' },
  { route: '/legal/promotions', importPath: '../src/pages/legal/PromotionsPage' },
  { route: '/legal/fair-gaming', importPath: '../src/pages/legal/FairGamingPage' },
  { route: '/legal/privacy', importPath: '../src/pages/legal/PrivacyPolicyPage' },
  { route: '/engine', importPath: '../src/pages/admin/EngineDashboard' },
  { route: '/analytics', importPath: '../src/pages/admin/AnalyticsDashboard' },
];

async function runAudit() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  CLUB ARENA E2E PAGE LOAD AUDIT — ${ALL_PAGES.length} pages`);
  console.log(`${'═'.repeat(70)}\n`);

  let passed = 0;
  let failed = 0;
  const failures: { route: string; importPath: string; error: string }[] = [];

  for (const page of ALL_PAGES) {
    try {
      const mod = await import(page.importPath);

      // Verify it has a default export
      if (!mod.default) {
        throw new Error('No default export found');
      }

      // Verify the default export is a function (React component)
      if (typeof mod.default !== 'function') {
        throw new Error(`Default export is ${typeof mod.default}, expected function`);
      }

      passed++;
      console.log(`  ✓ ${page.route.padEnd(45)} → ${page.importPath.split('/').pop()}`);
    } catch (err: any) {
      failed++;
      const msg = err.message || String(err);
      failures.push({ route: page.route, importPath: page.importPath, error: msg });
      console.log(`  ✗ ${page.route.padEnd(45)} → FAILED: ${msg}`);
    }
  }

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  RESULTS: ${passed} passed, ${failed} failed out of ${ALL_PAGES.length} pages`);
  console.log(`${'─'.repeat(70)}\n`);

  if (failures.length > 0) {
    console.log('  FAILURES:');
    for (const f of failures) {
      console.log(`    ${f.route}`);
      console.log(`      Import: ${f.importPath}`);
      console.log(`      Error:  ${f.error}\n`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

runAudit();
