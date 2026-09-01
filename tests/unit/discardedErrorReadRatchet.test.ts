/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DISCARDED-ERROR-READ RATCHET (2026-08-29, round 10)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `const { data } = await supabase...` without the error bound is the single
 * most repeated bug shape in this codebase's history: PostgREST RESOLVES with
 * `{ error }` rather than throwing, so a failed query is indistinguishable
 * from an empty result and the code answers a question it could not answer.
 * Rounds 7, 8 and 9 of the 2026-08 sweep closed FIFTY-TWO of these across
 * the tournament and table surfaces - among them a path that could cancel a
 * healthy tournament off a timeout, a money-path fork decided by a guess,
 * and duplicate money-action gates that failed open.
 *
 * This test is the ratchet that stops the shape returning. It counts the
 * pattern per file across all of src/ and compares against the baseline
 * frozen below:
 *
 *   - a file OVER its baseline fails - bind the error and act on it
 *     (report at minimum; fail closed on money paths);
 *   - a file NOT IN the baseline with any occurrence fails - new code binds
 *     its errors from day one;
 *   - a file UNDER its baseline still passes, but tighten the number here
 *     in the same commit so the ratchet only ever turns one way.
 *
 * The audited surfaces (TournamentService, TableService, TablePage,
 * ClubHomePage) are pinned at ZERO and must stay there.
 *
 * The remaining baseline entries are inherited debt, not endorsement - 275
 * occurrences existed when this was frozen. Shrink them as files get
 * touched.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = join(__dirname, '..', '..', 'src');

// Matches grep -E "const \{ (data|count)(: [A-Za-z_]+)? \} = await supabase"
const PATTERN = /const \{ (?:data|count)(?:: [A-Za-z_]+)? \} = await supabase/g;

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
};

const countsByFile = (): Map<string, number> => {
  const map = new Map<string, number>();
  for (const file of walk(SRC_ROOT)) {
    const n = (readFileSync(file, 'utf8').match(PATTERN) || []).length;
    if (n > 0) {
      const rel = 'src' + file.slice(SRC_ROOT.length).replace(/\\/g, '/');
      map.set(rel, n);
    }
  }
  return map;
};

/** Frozen 2026-08-30 (Community Command Center). 262 occurrences. Only ever shrink. */
const BASELINE = new Map<string, number>([
  ['src/services/HorseOrchestrator.ts', 11],
  // 13 -> 12: phase 3 of 7 removed distributeFromTreasury, distributeChips and
  // transferToAgent, and rewired transferToPlayer onto fn_agent_wallet_send.
  ['src/services/AgentService.ts', 12],
  ['src/pages/UnionDashboardPage.tsx', 10],
  ['src/services/UnionService.ts', 12],
  ['src/pages/AdminDashboardPage.tsx', 7],
  ['src/services/ClubsService.ts', 5],
  ['src/services/PromotionService.ts', 2],
  ['src/services/CreditService.ts', 5],
  ['src/pages/ClubDetailPage.tsx', 5],
  ['src/services/FriendSuggestionService.ts', 1],
  ['src/services/CreditRequestService.ts', 4],
  ['src/services/ChipFlowService.ts', 4],
  ['src/pages/HomePage.tsx', 4],
  ['src/pages/BadBeatJackpotPage.tsx', 4],
  ['src/components/social/PlayerActivityFeed.tsx', 4],
  ['src/components/agent/ChipTransferModal.tsx', 4],
  ['src/components/agent/AgentScoreCard.tsx', 4],
  ['src/services/VoiceSignalService.ts', 3],
  ['src/services/FinancialCronService.ts', 3],
  ['src/services/DisputeService.ts', 3],
  ['src/services/DiamondService.ts', 3],
  // 3 -> 2 on 2026-09-01: executePayout is gone, and with it the discarded
  // read it did on agent_commissions after calling execute_commission_payout.
  ['src/services/CommissionService.ts', 2],
  // TournamentResultsPage was cleared to 0 in round 10 (the deep-link work
  // touched the file, so its three reads were fixed under the ratchet's own
  // rule: shrink what you touch).
  ['src/pages/tournament/TournamentLobbyPage.tsx', 3],
  ['src/pages/VIPPage.tsx', 3],
  ['src/pages/RakebackDashboard.tsx', 3],
  ['src/pages/PlayerSessionsPage.tsx', 3],
  ['src/pages/NotificationsPage.tsx', 3],
  ['src/pages/ClubRulesPage.tsx', 3],
  ['src/pages/CashierTradePage.tsx', 0],
  ['src/pages/AntiCheatPage.tsx', 3],
  ['src/components/wallet/ChipMintModal.tsx', 3],
  ['src/components/agent/AgentCommissionDashboard.tsx', 3],
  ['src/utils/settlementLock.ts', 2],
  ['src/stores/useHeaderDataStore.ts', 2],
  ['src/services/WalletService.ts', 2],
  ['src/services/WaitlistService.ts', 1],
  ['src/services/TournamentTimerService.ts', 2],
  ['src/services/ThrowableService.ts', 1],
  ['src/services/ReferralService.ts', 1],
  ['src/services/NotificationService.ts', 2],
  ['src/services/MembershipService.ts', 2],
  ['src/services/LeaderboardService.ts', 2],
  ['src/services/HydraService.ts', 2],
  ['src/services/GTOQueryService.ts', 2],
  ['src/services/FinancialExportService.ts', 2],
  ['src/services/BonusService.ts', 2],
  ['src/services/AchievementTriggerService.ts', 1],
  ['src/pages/UnionGamesPage.tsx', 2],
  ['src/pages/SettlementPage.tsx', 2],
  ['src/pages/RateAuditPage.tsx', 2],
  ['src/pages/MultiTablePage.tsx', 2],
  ['src/pages/FlashPoolPage.tsx', 2],
  ['src/pages/CreditAdminPanel.tsx', 2],
  ['src/pages/ClubAnnouncementsPage.tsx', 2],
  ['src/components/tournament/TournamentStartingTicker.tsx', 2],
  ['src/components/social/OnlineFriendsPill.tsx', 2],
  ['src/components/social/FriendListPanel.tsx', 1],
  ['src/components/gameplay/PlayerNotesPanel.tsx', 1],
  ['src/components/common/UnionSkinGuard.tsx', 2],
  ['src/components/bbj/BBJTicker.tsx', 2],
  ['src/components/agent/PlayerInviteModal.tsx', 2],
  ['src/components/agent/AgentPromoPanel.tsx', 2],
  ['src/components/agent/AgentAnalyticsDashboard.tsx', 2],
  ['src/components/admin/ArenaLedger.tsx', 2],
  ['src/utils/unionScope.ts', 1],
  // 1 -> 0 on 2026-08-29. The discarded read was in filterByPreferences(),
  // which ran a preference query to decide who to send nothing to — the whole
  // send path has delivered nothing since OneSignal was retired. Query and
  // path both gone; sendToUsers() now reports every dropped notification.
  ['src/services/PushNotificationService.ts', 0],
  ['src/services/ProfileService.ts', 1],
  ['src/services/PermissionService.ts', 1],
  ['src/services/HandHistoryService.ts', 1],
  ['src/services/DailyChallengeService.ts', 1],
  ['src/services/BlockService.ts', 1],
  ['src/services/AvatarService.ts', 1],
  ['src/services/AdService.ts', 1],
  ['src/services/AchievementService.ts', 1],
  ['src/pages/admin/AnalyticsDashboard.tsx', 1],
  ['src/pages/XMTTPage.tsx', 1],
  ['src/pages/UnionStatementsPage.tsx', 1],
  ['src/pages/TournamentPage.tsx', 1],
  ['src/pages/TableConfigPage.tsx', 1],
  ['src/pages/SettlementHistoryPage.tsx', 1],
  ['src/pages/SettlementDashboardPage.tsx', 1],
  ['src/pages/SettingsPage.tsx', 1],
  ['src/pages/PromotionsPage.tsx', 1],
  ['src/pages/PromoVaultPage.tsx', 1],
  ['src/pages/ProfilePage.tsx', 1],
  ['src/pages/PlayerStatsPage.tsx', 0],
  ['src/pages/MemberManagementPage.tsx', 1],
  ['src/pages/MarketplacePage.tsx', 1],
  ['src/pages/InvitePage.tsx', 1],
  ['src/pages/CreateUnionPage.tsx', 1],
  ['src/pages/ClubFinancialsPage.tsx', 1],
  ['src/lib/authToken.ts', 1],
  ['src/hooks/useTableChat.ts', 1],
  ['src/hooks/useEffectiveRake.ts', 1],
  ['src/components/waitlist/WaitlistManager.tsx', 1],
  ['src/components/tournament/TournamentRankingCard.tsx', 1],
  ['src/components/tournament/MysteryBountyPanel.tsx', 1],
  ['src/components/tournament/MysteryBountyCelebration.tsx', 1],
  ['src/components/table/RealTimeResultPanel.tsx', 1],
  ['src/components/social/PresenceIndicator.tsx', 1],
  ['src/components/session/SessionSummaryHost.tsx', 1],
  ['src/components/navigation/NotificationDropdown.tsx', 1],
  ['src/components/navigation/HamburgerMenu.tsx', 1],
  ['src/components/dashboard/AgentFinancialPortal.tsx', 1],
  ['src/components/club/CreateTournamentModal.tsx', 1],
  ['src/components/agent/AgentAssignmentPanel.tsx', 1],
  ['src/components/admin/StatsExport.tsx', 1],
  ['src/components/admin/PlayerSearch.tsx', 1],
  ['src/components/admin/ClubMemberManagement.tsx', 1],
  ['src/components/admin/AuditLog.tsx', 1],
]);

/** The 2026-08 sweep left these at zero. They stay there. */
const AUDITED_ZERO = [
  'src/services/TournamentService.ts',
  'src/services/TableService.ts',
  'src/pages/TablePage.tsx',
  'src/pages/ClubHomePage.tsx',
];

describe('discarded-error-read ratchet', () => {
  const current = countsByFile();

  it('the audited surfaces stay at zero', () => {
    for (const file of AUDITED_ZERO) {
      expect(current.get(file) ?? 0, `${file} regained a discarded-error read`).toBe(0);
    }
  });

  it('no file exceeds its frozen baseline, and new files start clean', () => {
    const violations: string[] = [];
    for (const [file, n] of current) {
      const allowed = BASELINE.get(file) ?? 0;
      if (n > allowed) {
        violations.push(
          `${file}: ${n} discarded-error read(s), baseline ${allowed}. ` +
            `Bind the error (const { data, error } = ...) and act on it - ` +
            `report at minimum, fail closed on money paths.`
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('a shrunk file tightens its baseline in the same commit', () => {
    // Advisory pin: when a file drops below its baseline, this fails so the
    // number above gets lowered - the ratchet only ever turns one way.
    const stale: string[] = [];
    for (const [file, allowed] of BASELINE) {
      const n = current.get(file) ?? 0;
      if (n < allowed) {
        stale.push(`${file}: now ${n}, baseline says ${allowed} - lower the baseline entry.`);
      }
    }
    expect(stale, stale.join('\n')).toEqual([]);
  });
});
