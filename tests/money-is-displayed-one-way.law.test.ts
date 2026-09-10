/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW — MONEY IS DISPLAYED ONE WAY (2026-09-10)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The 2026-09-08 audit (CL-7) counted 30+ distinct money formatters in src/:
 * seven truncating, fourteen rounding, four abbreviating and five with no
 * fraction options at all. The same wallet balance read a cent apart on two
 * pages; a commission of 12.3456 read "12.346" because a bare toLocaleString()
 * gives Intl's default of THREE decimals; a 1,250,000 and a 1,349,000 first
 * and second prize both read "1.3M"; a session net of -0.49 read "0"; a pot
 * that could not be computed read "0".
 *
 * There is now ONE home for turning a chip amount into text,
 * `src/utils/format.ts`, and one family inside it:
 *
 *   formatChips        money off the felt - two places, separators, truncated
 *   formatSignedChips  the same with a leading sign for a P/L
 *   formatTableChips   chips on the felt / tournament clocks - integers clean
 *   formatStackChips   a seat's stack - pennies under 100, whole above
 *   formatChipAward    the "+N" riding with money arriving at a seat
 *
 * The rulings behind it are Dan's, verbatim, and older than this file:
 *   2026-08-28 "CHIPS SHOULD ALWAYS BE DISPLAYED IN [WHOLE] NUMBERS, NEVER
 *              ROUNDED OR SHORTENED" - no K/M suffix, anywhere.
 *   2026-08-29 "THERE CAN NEVER BE 'ROUNDING' IT MUST ALWAYS BE DOWN TO THE
 *              CENT", 2026-09-04 "ABSOLUTELY ZERO ROUNDING ANYWHERE EVER".
 *   CLAUDE.md 5.5: separators via toLocaleString, never padStart.
 *
 * Three kinds of pin:
 *   1. the formatter itself behaves as the rulings say;
 *   2. the historical import paths (lib/utils, utils/clubDashboard) are
 *      re-exports of it, never a second implementation;
 *   3. a RATCHET: the files that still format money on their own are listed
 *      here, by name. A file may leave the list (fix it, delete the line). A
 *      file may not join it. Any NEW ad-hoc money formatting fails this test
 *      with the name of the function to call instead.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as format from '../src/utils/format';
import * as libUtils from '../src/lib/utils';
import * as clubDashboard from '../src/utils/clubDashboard';

const root = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

/** Source with block and line comments removed, so prose about a retired bug
 *  never satisfies (or trips) a pin meant for live code. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const SRC_FILES = walk(join(root, 'src')).map((f) => relative(root, f));
const CANONICAL = 'src/utils/format.ts';

describe('LAW: the one money formatter behaves as Dan ruled', () => {
  it('formatChips is two places, separators, truncated, never NaN', () => {
    expect(format.formatChips(1234.5)).toBe('1,234.50');
    expect(format.formatChips(1250000)).toBe('1,250,000.00');
    expect(format.formatChips(1349000)).toBe('1,349,000.00');
    // 12.3456 is "12.34": truncated, and never Intl's default three places.
    expect(format.formatChips(12.3456)).toBe('12.34');
    expect(format.formatChips(12.5)).toBe('12.50');
    expect(format.formatChips(0.999)).toBe('0.99');
    // Binary floats: 2183.7 * 100 is 218369.99999999997.
    expect(format.formatChips(2183.7)).toBe('2,183.70');
    expect(format.formatChips('2183.7')).toBe('2,183.70');
    expect(format.formatChips(-0.49)).toBe('-0.49');
    expect(format.formatChips(-0.004)).toBe('0.00');
    for (const bad of [NaN, Infinity, -Infinity, null, undefined, '', 'abc', {}]) {
      expect(format.formatChips(bad)).toBe('0.00');
    }
  });

  it('formatSignedChips never shows a real loss as break-even', () => {
    // CL-13: a session net of -0.49 rendered "0" on the end-of-session card.
    expect(format.formatSignedChips(-0.49)).toBe('-0.49');
    expect(format.formatSignedChips(1711.5)).toBe('+1,711.50');
    expect(format.formatSignedChips(0)).toBe('0.00');
    expect(format.formatSignedChips(-0.004)).toBe('0.00');
    expect(format.formatSignedChips(NaN)).toBe('0.00');
  });

  it('no export of the canonical module abbreviates', () => {
    expect((format as Record<string, unknown>).fmtChips).toBeUndefined();
    for (const fn of [
      format.formatChips,
      format.formatTableChips,
      format.formatStackChips,
      format.formatChipAward,
    ]) {
      for (const v of [1500, 117000, 1250000, 1349000]) {
        expect(fn(v)).not.toMatch(/[KM]$/);
      }
    }
    expect(format.formatTableChips(1250000)).toBe('1,250,000');
    expect(format.formatTableChips(10400)).toBe('10,400');
    expect(format.formatTableChips(10600)).toBe('10,600');
  });
});

describe('LAW: the historical import paths are re-exports, not second implementations', () => {
  it('lib/utils formatChips IS utils/format formatChips', () => {
    expect(libUtils.formatChips).toBe(format.formatChips);
    expect(code(read('src/lib/utils.ts'))).toMatch(
      /export \{ formatChips \} from '\.\.\/utils\/format';/
    );
  });

  it('lib/utils formatCurrency has no currency parameter it ignores (CL-39)', () => {
    expect(libUtils.formatCurrency.length).toBe(1);
    expect(libUtils.formatCurrency(1234.5)).toBe(format.formatChips(1234.5));
    expect(code(read('src/lib/utils.ts'))).not.toMatch(/formatCurrency\(amount: number, currency/);
  });

  it('utils/clubDashboard formatChips and formatSigned delegate', () => {
    for (const v of [1234.5, 0.999, -12.3, 0, -0.004]) {
      expect(clubDashboard.formatChips(v)).toBe(format.formatChips(v));
      expect(clubDashboard.formatSigned(v)).toBe(format.formatSignedChips(v));
    }
    const src = code(read('src/utils/clubDashboard.ts'));
    expect(src).not.toMatch(/Math\.trunc\(num \* 100\) \/ 100/);
  });

  it('lib/utils, lib/format and clubDashboard hold no Intl option bag of their own', () => {
    for (const rel of ['src/lib/utils.ts', 'src/utils/clubDashboard.ts']) {
      expect(code(read(rel)), rel).not.toMatch(/FractionDigits/);
    }
  });
});

describe('LAW: nothing in src/ abbreviates, pads or invents a money format', () => {
  it('no K/M ladder anywhere (Dan 2026-08-28)', () => {
    // `(n / 1000).toFixed(1)}K`, `Math.round(n / 1000)}K`, `toFixed(1) + 'M'`.
    const ladder = /(toFixed\(\d\)|\/\s*1[_,]?000(?:[_,]?000)?\))\s*\}?\s*\+?\s*['"`]?\s*[KM]\b/;
    for (const rel of SRC_FILES) {
      expect(code(read(rel)), `${rel} abbreviates chips - use formatChips`).not.toMatch(ladder);
    }
  });

  it('no padStart on a number - separators come from toLocaleString (CLAUDE.md 5.5)', () => {
    // The clock is the one legitimate padStart: "9:05". Anything else is the
    // Bad Beat Jackpot bug ("000012345") coming back.
    for (const rel of SRC_FILES) {
      const src = code(read(rel)).replace(/padStart\(2, '0'\)/g, '');
      expect(src, `${rel} pads a number - use formatChips`).not.toMatch(/\.padStart\(/);
    }
  });

  it('fmtChips is gone and stays gone', () => {
    for (const rel of SRC_FILES) {
      expect(code(read(rel)), rel).not.toMatch(/\bfmtChips\b/);
    }
  });

  /*
   * THE RATCHET. Every file below still carries its own Intl option bag
   * (minimum/maximumFractionDigits) or a bare `.toLocaleString()` on a money
   * identifier. They are listed so the list can only shrink: fix a file, delete
   * its line, and the test keeps you honest. A file NOT on the list that grows
   * one of these fails with the name of the function to call instead.
   *
   * Do not add a line to either list. That is the whole law.
   */
  const OWN_OPTION_BAG = [
    'src/components/Shell.tsx',
    'src/components/agent/AgentBackOffice.tsx',
    'src/components/agent/AgentCommissionDashboard.tsx',
    'src/components/agent/CreditRequestWidget.tsx',
    'src/components/agent/DownlineRakePanel.tsx',
    'src/components/bbj/BBJBasicPanel.tsx',
    'src/components/bbj/BBJInfoModal.tsx',
    'src/components/bbj/BBJTicker.tsx',
    'src/components/cash/CashGameCreateFlow.tsx',
    'src/components/club/ClubOpeningWizard.tsx',
    'src/components/club/ClubStatsCards.tsx',
    'src/components/club/RakeSnapshotPanel.tsx',
    'src/components/club/SpinActivationPanel.tsx',
    'src/components/club/TableOperationsPanel.tsx',
    'src/components/leaderboard/LeaderboardCard.tsx',
    'src/components/leaderboard/LeaderboardPrizeWizard.tsx',
    'src/components/lobby/lobbyEntries.ts',
    'src/components/modals/FindPlayerModal.tsx',
    'src/components/players/PlayerCard.tsx',
    'src/components/stats/EVLuckChart.tsx',
    'src/components/stats/NemesisPanel.tsx',
    'src/components/stats/TrophyRoom.tsx',
    'src/components/table/BBJCelebration.tsx',
    'src/components/table/BadBeatJackpot.tsx',
    'src/components/table/ChipAnimation.tsx',
    'src/components/table/HeroHubPanel.tsx',
    'src/components/table/LeaderboardPanel.tsx',
    'src/components/table/LeaveTableConfirm.tsx',
    'src/components/table/RealTimeResultPanel.tsx',
    'src/components/table/RealTimeResults.tsx',
    'src/components/table/SeatSlot.tsx',
    'src/components/table/TournamentBreakScreen.tsx',
    'src/components/tournament/MysteryBountyCelebration.tsx',
    'src/components/tournament/SpinWheel.tsx',
    'src/components/tournament/TournamentInfoPanel.tsx',
    'src/components/tournament/TournamentRankingCard.tsx',
    'src/components/union/UnionAgentStatements.tsx',
    'src/components/union/UnionClubGovernance.tsx',
    'src/components/union/UnionOpsPanel.tsx',
    'src/components/union/UnionWalletModal.tsx',
    'src/components/wallet/ChipStatement.tsx',
    'src/components/wallet/DepositWithdrawModal.tsx',
    'src/components/wallet/DynamicWallet.tsx',
    'src/components/wallet/PlayerWalletModal.tsx',
    'src/components/wallet/WalletCashierModal.tsx',
    'src/hooks/index.ts',
    'src/pages/AgentManagementPage.tsx',
    'src/pages/BadBeatJackpotPage.tsx',
    'src/pages/CashierTradePage.tsx',
    'src/pages/ClubFinancialsPage.tsx',
    'src/pages/ClubHomePage.tsx',
    'src/pages/ClubMembersPage.tsx',
    'src/pages/DriftIncidentsPage.tsx',
    'src/pages/MemberManagementPage.tsx',
    'src/pages/PlayerStatisticsPage.tsx',
    'src/pages/ProfilePage.tsx',
    'src/pages/SettlementPage.tsx',
    'src/pages/TablePage.tsx',
    'src/pages/UnionDetailPage.tsx',
    'src/pages/UnionStatementsPage.tsx',
    'src/pages/admin/AnalyticsDashboard.tsx',
    'src/pages/club/ClubBombPotReportPage.tsx',
    'src/pages/club/ClubDataPage.tsx',
    'src/pages/club/ClubInsuranceReportPage.tsx',
    'src/pages/dev/ClubWalletPreviewPage.tsx',
    'src/pages/stats/RakeTab.tsx',
    'src/pages/tournament/TournamentResultsPage.tsx',
    'src/services/MysteryBountyService.ts',
    'src/services/TournamentService.ts',
    'src/utils/buyIn.ts',
    'src/utils/handFormat.ts',
  ];

  const BARE_MONEY_TOLOCALESTRING = [
    'src/components/admin/ClubMemberManagement.tsx',
    'src/components/admin/PlayerSearch.tsx',
    'src/components/admin/RakeReports.tsx',
    'src/components/agent/AgentAnalyticsDashboard.tsx',
    'src/components/agent/AgentCashoutPanel.tsx',
    'src/components/agent/AgentCommissionDashboard.tsx',
    'src/components/agent/AgentPromoPanel.tsx',
    'src/components/agent/ChipTransferModal.tsx',
    'src/components/agent/CreditRequestWidget.tsx',
    'src/components/agent/DistributionHistory.tsx',
    'src/components/club/AdminReports.tsx',
    'src/components/club/AgentManager.tsx',
    'src/components/club/JackpotHistory.tsx',
    'src/components/club/MemberList.tsx',
    'src/components/common/Button.tsx',
    'src/components/dashboard/ClubFinancialDashboard.tsx',
    'src/components/gamification/LuckyDrawWheel.tsx',
    'src/components/history/SessionGraph.tsx',
    'src/components/leaderboard/LeaderboardCard.tsx',
    'src/components/lobby/GameLobbyPanel.tsx',
    'src/components/navigation/HamburgerMenu.tsx',
    'src/components/promotions/PromotionCarousel.tsx',
    'src/components/promotions/PromotionDetail.tsx',
    'src/components/promotions/PromotionsList.tsx',
    'src/components/quickactions/QuickLeaveButton.tsx',
    'src/components/settlement/SettlementReceipt.tsx',
    'src/components/settlement/SettlementTimeline.tsx',
    'src/components/social/ReferralDashboard.tsx',
    'src/components/stats/BankrollTracker.tsx',
    'src/components/stats/PositionWinRates.tsx',
    'src/components/stats/SessionHistory.tsx',
    'src/components/table/ActionErrorToast.tsx',
    'src/components/table/AddOnModal.tsx',
    'src/components/table/BombPotOverlay.tsx',
    'src/components/table/GameRulesModal.tsx',
    'src/components/table/HandNotation.tsx',
    'src/components/table/InsuranceModal.tsx',
    'src/components/table/PlayerStats.tsx',
    'src/components/table/RunItTwice.tsx',
    'src/components/table/SessionAnalytics.tsx',
    'src/components/table/SessionHUD.tsx',
    'src/components/table/SessionStatsTracker.tsx',
    'src/components/table/ShareHand.tsx',
    'src/components/table/StraddleToggle.tsx',
    'src/components/tournament/FinalTableOverlay.tsx',
    'src/components/tournament/MysteryBountyChest.tsx',
    'src/components/tournament/PayoutStructureEditor.tsx',
    'src/components/tournament/SpinWheel.tsx',
    'src/components/tournament/TournamentLobbyCard.tsx',
    'src/components/training/EVCalculator.tsx',
    'src/components/vip/VIPActivityHistory.tsx',
    'src/components/wallet/CashoutRequestModal.tsx',
    'src/components/wallet/DepositWithdrawModal.tsx',
    'src/components/wallet/DiamondWalletModal.tsx',
    'src/components/wallet/DiamondWalletTransfer.tsx',
    'src/components/wallet/TransactionHistory.tsx',
    'src/hooks/useTableChat.ts',
    'src/lib/export.ts',
    'src/pages/AgentPortalPage.tsx',
    'src/pages/BadBeatJackpotPage.tsx',
    'src/pages/CashierPage.tsx',
    'src/pages/ClubDetailPage.tsx',
    'src/pages/ClubSettingsPage.tsx',
    'src/pages/ClubsPage.tsx',
    'src/pages/CreditAdminPanel.tsx',
    'src/pages/DailyChallengesPage.tsx',
    'src/pages/DisputeManagementPage.tsx',
    'src/pages/FlashPoolPage.tsx',
    'src/pages/GameManagementPage.tsx',
    'src/pages/LeaderboardPage.tsx',
    'src/pages/PlayerStatsPage.tsx',
    'src/pages/PlayerWalletPage.tsx',
    'src/pages/PromotionsPage.tsx',
    'src/pages/RakebackDashboard.tsx',
    'src/pages/RakebackPage.tsx',
    'src/pages/SettlementDashboardPage.tsx',
    'src/pages/SettlementHistoryPage.tsx',
    'src/pages/SuperAgentDashboard.tsx',
    'src/pages/TablePage.tsx',
    'src/pages/TransactionHistoryPage.tsx',
    'src/pages/UnionDashboardPage.tsx',
    'src/pages/UnionDetailPage.tsx',
    'src/pages/admin/AnalyticsDashboard.tsx',
    'src/pages/stats/AnalysisTab.tsx',
    'src/pages/stats/OverviewTab.tsx',
    'src/pages/stats/PerformanceTab.tsx',
    'src/pages/stats/RakeTab.tsx',
    'src/pages/stats/TournamentsTab.tsx',
    'src/pages/tournament/TournamentResultsPage.tsx',
    'src/services/CashoutService.ts',
    'src/services/ChipFlowService.ts',
    'src/services/NotificationService.ts',
    'src/services/PushNotificationService.ts',
    'src/utils/clubSettingsRules.ts',
  ];

  const MONEY_WORD =
    '(amount|balance|chips|prize|pot|payout|commission|bounty|rake|buyin|buy_in|wallet|earned|paid|profit|winnings|cashout|deposit|withdraw|stack|fee)';
  const BARE = new RegExp(`\\b[A-Za-z_.$]*${MONEY_WORD}[A-Za-z_]*\\.toLocaleString\\(\\)`, 'i');

  it('a file outside the ratchet does not grow its own Intl option bag', () => {
    const offenders = SRC_FILES.filter(
      (rel) =>
        rel !== CANONICAL &&
        !OWN_OPTION_BAG.includes(rel) &&
        /(minimum|maximum)FractionDigits/.test(code(read(rel)))
    );
    expect(
      offenders,
      `new ad-hoc money formatting in: ${offenders.join(', ')}. Call formatChips / formatTableChips from src/utils/format.ts instead of toLocaleString with FractionDigits.`
    ).toEqual([]);
  });

  it('a file outside the ratchet does not call bare toLocaleString() on money', () => {
    const offenders = SRC_FILES.filter(
      (rel) =>
        rel !== CANONICAL && !BARE_MONEY_TOLOCALESTRING.includes(rel) && BARE.test(code(read(rel)))
    );
    expect(
      offenders,
      `bare .toLocaleString() on a money value in: ${offenders.join(', ')}. Intl's default is THREE fraction digits - call formatChips from src/utils/format.ts.`
    ).toEqual([]);
  });

  it('the ratchet lists only files that still exist and still offend (so it shrinks)', () => {
    // A line whose file was fixed, or deleted, is a line to remove - otherwise
    // the list reads as bigger than the debt it describes.
    const staleBag = OWN_OPTION_BAG.filter(
      (rel) => !SRC_FILES.includes(rel) || !/(minimum|maximum)FractionDigits/.test(code(read(rel)))
    );
    const staleBare = BARE_MONEY_TOLOCALESTRING.filter(
      (rel) => !SRC_FILES.includes(rel) || !BARE.test(code(read(rel)))
    );
    expect(staleBag, 'fixed or gone - delete from OWN_OPTION_BAG').toEqual([]);
    expect(staleBare, 'fixed or gone - delete from BARE_MONEY_TOLOCALESTRING').toEqual([]);
  });

  it('the files this law was written against are off the ratchet for good', () => {
    for (const rel of [
      'src/components/agent/CommissionHistoryModal.tsx',
      'src/components/agent/AgentTree.tsx',
      'src/components/wallet/describeChipTransaction.ts',
      'src/components/tournament/PayoutStructure.tsx',
      'src/components/session/SessionSummaryHost.tsx',
      'src/components/tournament/TournamentClock.tsx',
      'src/components/tournament/TournamentHUD.tsx',
      'src/components/agent/AgentScoreCard.tsx',
      'src/components/table/CashierModal.tsx',
      'src/components/table/BuyInModal.tsx',
      'src/components/table/PotDisplay.tsx',
      'src/components/club/CashierModal.tsx',
      'src/components/table/ClubProfileModal.tsx',
      'src/components/club/ClubActivityChart.tsx',
      'src/pages/TournamentPage.tsx',
    ]) {
      expect(OWN_OPTION_BAG, rel).not.toContain(rel);
      expect(BARE_MONEY_TOLOCALESTRING, rel).not.toContain(rel);
      expect(code(read(rel)), `${rel} imports the canonical formatter`).toMatch(
        /from '(\.\.\/)+utils\/format'/
      );
    }
  });
});

describe('LAW: the pins behind each audit finding', () => {
  it('CL-11 the tournament payout list renders through formatChips, never a raw expression', () => {
    const src = code(read('src/pages/TournamentPage.tsx'));
    expect(src).toMatch(/amount === null \? '-' : formatChips\(amount\)/);
    expect(src).not.toMatch(/payout-amount">\s*\{[^}]*\*/);
  });

  it('CL-14 a pot that cannot be computed reads "-", never "0"', () => {
    const src = code(read('src/components/table/PotDisplay.tsx'));
    expect(src).toMatch(/if \(!Number\.isFinite\(amount\)\) return '-';/);
  });

  it('CL-42 the two money-entry modals share the formatter instead of a copy', () => {
    for (const rel of [
      'src/components/table/CashierModal.tsx',
      'src/components/table/BuyInModal.tsx',
    ]) {
      const src = code(read(rel));
      expect(src, rel).not.toMatch(/function formatAmount\(/);
      expect(src, rel).toMatch(/formatChips\(/);
    }
  });
});

describe('LAW: a money field is named, described and visible to the keyboard', () => {
  it('CL-5 AmountInput binds its label, its error and its invalid state', () => {
    const src = code(read('src/components/inputs/AmountInput.tsx'));
    expect(src).toMatch(/htmlFor=\{inputId\}/);
    expect(src).toMatch(/id=\{inputId\}/);
    expect(src).toMatch(/aria-invalid=\{error \? true : undefined\}/);
    expect(src).toMatch(/aria-describedby=\{error \? errorId : undefined\}/);
    expect(src).toMatch(/id=\{errorId\}/);
    expect(src).toMatch(/role="alert"/);
  });

  it('CL-35 the money field never hides keyboard focus', () => {
    const css = read('src/components/inputs/AmountInput.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/\.amount-input:focus\s*\{\s*outline:\s*none;?\s*\}/);
    expect(css).toMatch(/\.amount-container:focus-within\s*\{[^}]*outline:\s*2px solid/);
  });

  it('CL-6 the club cashier amount is labelled by htmlFor', () => {
    const src = code(read('src/components/club/CashierModal.tsx'));
    expect(src).toMatch(/htmlFor=\{`club-cashier-amount-\$\{activeTab\}`\}/);
    expect(src).toMatch(/id=\{`club-cashier-amount-\$\{activeTab\}`\}/);
  });

  it('CL-34 a tournament card is a keyboard control', () => {
    const src = code(read('src/pages/TournamentPage.tsx'));
    const card = src.slice(
      src.indexOf('className={`tournament-card') - 400,
      src.indexOf('className={`tournament-card') + 900
    );
    expect(card).toMatch(/role="button"/);
    expect(card).toMatch(/tabIndex=\{0\}/);
    expect(card).toMatch(/onKeyDown/);
    expect(card).toMatch(/e\.key === 'Enter' \|\| e\.key === ' '/);
  });

  it('CL-36 / CL-37 the VIP and report overlays are dialogs a keyboard can leave', () => {
    for (const [rel, label] of [
      ['src/components/vip/VIPCardsModal.tsx', 'Close VIP'],
      ['src/components/moderation/ReportPlayerModal.tsx', 'Close Report'],
    ] as const) {
      const src = code(read(rel));
      expect(src, rel).toMatch(/role="dialog"/);
      expect(src, rel).toMatch(/aria-modal="true"/);
      expect(src, rel).toMatch(/aria-labelledby=/);
      expect(src, rel).toMatch(/useDialogEscape\(isOpen, onClose\)/);
      expect(src, rel).toMatch(/useFocusTrap<HTMLDivElement>\(isOpen\)/);
      expect(src, rel).toContain(`aria-label="${label}"`);
    }
  });
});
