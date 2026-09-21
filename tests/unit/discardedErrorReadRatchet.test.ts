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
  ['src/services/HorseOrchestrator.ts', 8],
  // 13 -> 12: phase 3 of 7 removed distributeFromTreasury, distributeChips and
  // transferToAgent, and rewired transferToPlayer onto fn_agent_wallet_send.
  // 12 -> 11 on 2026-09-03: phase 3 removed clawbackDistribution and
  // getRecentDistributions, a dead parallel implementation of agent undo whose
  // reads went nowhere anyway.
  ['src/services/AgentService.ts', 7],
  // 10 -> 8: union route/account authorization now reports both canonical
  // operator lookup failures instead of discarding them during a stale load.
  ['src/pages/UnionDashboardPage.tsx', 7],
  ['src/services/UnionService.ts', 11],
  ['src/pages/AdminDashboardPage.tsx', 6],
  ['src/services/ClubsService.ts', 5],
  ['src/services/PromotionService.ts', 2],
  ['src/services/CreditService.ts', 4],
  // 5 -> 4: the legacy optimistic table delete and its unchecked reload were
  // removed when all operator closes moved behind fn_close_managed_game.
  ['src/pages/ClubDetailPage.tsx', 4],
  ['src/services/FriendSuggestionService.ts', 1],
  ['src/services/CreditRequestService.ts', 1],
  ['src/services/ChipFlowService.ts', 4],
  /* 4 -> 2 on 2026-09-11: removing the promo-rain control took two discarded
     reads with it (the owner probe and the rain handler's catch). The ratchet
     asked for this in the same commit, which is the point of it. */
  /* ZERO SINCE 2026-09-11 (was 2). Both were the reads that resolve which
     pool this page is about, and both discarded errors turned "could not ask"
     into "this club has no jackpot" - one on the render path, where the
     "Could Not Load The Jackpot" screen the file already contained was
     therefore unreachable, and one on the realtime path, where it built a
     subscription filter a union club's rows never match. The entry stays at 0
     rather than being deleted so a reintroduction is a diff on this line. */
  ['src/pages/BadBeatJackpotPage.tsx', 0],
  ['src/components/social/PlayerActivityFeed.tsx', 4],
  ['src/components/agent/ChipTransferModal.tsx', 2],
  ['src/services/VoiceSignalService.ts', 3],
  // 3 -> 1 on 2026-09-20: submitDispute and withdrawDispute stopped doing raw
  // table writes and now call fn_dispute_submit / fn_dispute_withdraw, which
  // report a reason instead of an ignored error.
  ['src/services/DisputeService.ts', 1],
  ['src/services/DiamondService.ts', 1],
  // 3 -> 2 on 2026-09-01: executePayout is gone, and with it the discarded
  // read it did on agent_commissions after calling execute_commission_payout.
  ['src/services/CommissionService.ts', 1],
  // TournamentResultsPage was cleared to 0 in round 10 (the deep-link work
  // touched the file, so its three reads were fixed under the ratchet's own
  // rule: shrink what you touch).
  /* ZERO SINCE 2026-09-21 (was 3). All three turned "the read did not answer"
     into a confident wrong answer, which is CLAUDE.md 10.86 rule 1 in one
     file: the player's registration list became "registered for nothing", so
     a board of live Register (buy-in) buttons was shown to a player already
     in every event; union membership became "standalone"; and the union scope
     read became "no union", quietly dropping every union game off the board.
     The two union reads keep the outcome they always had (fail open on the
     affordance, fail closed on scope) - what they no longer do is reach it by
     accident. Kept at 0 rather than deleted so a reintroduction is a diff on
     this line. */
  ['src/pages/tournament/TournamentLobbyPage.tsx', 0],
  ['src/pages/VIPPage.tsx', 2],
  ['src/pages/NotificationsPage.tsx', 0],
  ['src/pages/ClubRulesPage.tsx', 0],
  ['src/pages/CashierTradePage.tsx', 0],
  ['src/pages/AntiCheatPage.tsx', 3],
  ['src/components/wallet/ChipMintModal.tsx', 3],
  // 3 -> 2 in phase 7: the sub-agent read that discarded its error is gone with
  // the dropped column it was reading, and its replacement binds the error.
  ['src/components/agent/AgentCommissionDashboard.tsx', 0],
  ['src/utils/settlementLock.ts', 2],
  ['src/stores/useHeaderDataStore.ts', 2],
  ['src/services/WalletService.ts', 2],
  // TournamentTimerService now binds and reports both observer read errors.
  ['src/services/TournamentTimerService.ts', 0],
  ['src/services/ThrowableService.ts', 0],
  ['src/services/ReferralService.ts', 1],
  ['src/services/NotificationService.ts', 2],
  ['src/services/MembershipService.ts', 2],
  ['src/services/LeaderboardService.ts', 2],
  // 2 -> 0 in chip-std cash (2026-09-02, C2): both discarded reads lived in
  // seatHorse, the browser-side seat creator that minted a stack; it is gone
  // with its reads, and the server fleet is the one seat creator for horses.
  ['src/services/HydraService.ts', 0],
  ['src/services/FinancialExportService.ts', 0],
  // BonusService.ts was deleted 2026-09-07 with the chip daily-bonus ladder.
  /* 0 since 2026-09-05: the last unbound read here was the player_stats
     lookup in updateUserStats, which is now `const { data, error }` and
     reports. See the note in that function - it was also asking a per-club
     table for a single row. */
  ['src/services/AchievementTriggerService.ts', 0],
  ['src/pages/UnionGamesPage.tsx', 2],
  ['src/pages/MultiTablePage.tsx', 1],
  ['src/pages/FlashPoolPage.tsx', 0],
  ['src/pages/CreditAdminPanel.tsx', 0],
  ['src/pages/ClubAnnouncementsPage.tsx', 1],
  ['src/components/tournament/TournamentStartingTicker.tsx', 0],
  ['src/components/social/OnlineFriendsPill.tsx', 2],
  ['src/components/social/FriendListPanel.tsx', 1],
  ['src/components/gameplay/PlayerNotesPanel.tsx', 1],
  ['src/components/common/UnionSkinGuard.tsx', 2],
  ['src/components/agent/PlayerInviteModal.tsx', 2],
  ['src/components/agent/AgentPromoPanel.tsx', 2],
  ['src/components/agent/AgentAnalyticsDashboard.tsx', 1],
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
  // 1 -> 0 on 2026-09-06. Daily Mission mutations now preserve and classify
  // PostgREST failures so retryable deadlocks cannot disappear into `void`.
  ['src/services/DailyChallengeService.ts', 0],
  ['src/services/BlockService.ts', 1],
  ['src/services/AvatarService.ts', 1],
  ['src/services/AdService.ts', 1],
  ['src/services/AchievementService.ts', 1],
  ['src/pages/admin/AnalyticsDashboard.tsx', 0],
  ['src/pages/XMTTPage.tsx', 0],
  ['src/pages/UnionStatementsPage.tsx', 1],
  ['src/pages/TournamentPage.tsx', 1],
  ['src/pages/TableConfigPage.tsx', 1],
  ['src/pages/SettingsPage.tsx', 1],
  ['src/pages/PromotionsPage.tsx', 0],
  ['src/pages/PromoVaultPage.tsx', 1],
  ['src/pages/ProfilePage.tsx', 0],
  ['src/pages/PlayerStatsPage.tsx', 0],
  ['src/pages/MemberManagementPage.tsx', 1],
  ['src/pages/MarketplacePage.tsx', 0],
  ['src/pages/InvitePage.tsx', 1],
  ['src/pages/CreateUnionPage.tsx', 1],
  ['src/lib/authToken.ts', 1],
  ['src/hooks/useTableChat.ts', 1],
  ['src/hooks/useEffectiveRake.ts', 1],
  ['src/components/waitlist/WaitlistManager.tsx', 1],
  ['src/components/tournament/TournamentRankingCard.tsx', 1],
  ['src/components/tournament/MysteryBountyPanel.tsx', 1],
  ['src/components/tournament/MysteryBountyCelebration.tsx', 1],
  ['src/components/social/PresenceIndicator.tsx', 1],
  ['src/components/session/SessionSummaryHost.tsx', 1],
  ['src/components/navigation/NotificationDropdown.tsx', 1],
  ['src/components/navigation/HamburgerMenu.tsx', 1],
  ['src/components/club/CreateTournamentModal.tsx', 1],
  ['src/components/agent/AgentAssignmentPanel.tsx', 1],
  ['src/components/admin/StatsExport.tsx', 1],
  ['src/components/admin/PlayerSearch.tsx', 1],
  ['src/components/admin/AuditLog.tsx', 1],
]);

/** The 2026-08 sweep left these at zero. They stay there. */
const AUDITED_ZERO = [
  // 2026-09-04, phase 4: the profiles read now throws on error.
  'src/components/admin/ClubMemberManagement.tsx',
  // 2026-09-04, phase 6: the page makes ONE gated RPC call and binds its
  // error; the reads that used to discard one (rake, rakeback, invoices) are
  // gone with the browser aggregation they fed.
  'src/pages/ClubFinancialsPage.tsx',
  // 2026-09-05, phase 7: the auto-settlement read no longer swallows its
  // failure ("non-critical: default to false" drew the switch OFF for a club
  // whose setting was ON), and the write asks for the row it changed.
  'src/pages/SettlementPage.tsx',
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
