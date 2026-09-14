/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW: A REALTIME SUBSCRIPTION IS TO A PUBLISHED TABLE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Supabase's `postgres_changes` delivers rows only for tables in the
 * `supabase_realtime` PUBLICATION. Subscribe to a table outside it and nothing
 * goes wrong in any way you can see: the channel opens, the status callback
 * reports `SUBSCRIBED`, the handler is attached, and no event ever arrives.
 * There is no error, no warning and no log line. The screen is simply stale
 * forever, and the only way to notice is to sit in front of it and wait for an
 * update that never comes.
 *
 * That is not a hypothetical failure mode on this platform. Measured against
 * production on 2026-09-14:
 *
 *   `SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime'`
 *     -> club_members, notifications, tournament_bounty_obligations,
 *        tournament_deal_votes, tournament_manager_wakes
 *
 *   `src/` at the same moment
 *     -> 115 postgres_changes subscriptions, of which 105 across 62 files named
 *        a table that is not one of those five.
 *
 * Thirteen listeners on `tournaments`. Seven on `tables`. Six on `table_seats`.
 * Five each on `tournament_players`, `clubs`, `agents`, `agent_commissions` and
 * `chip_transactions`. None of them has ever fired.
 *
 * ── WHAT THIS LAW DOES, AND WHAT IT DELIBERATELY DOES NOT ──────────────────
 *
 * It does NOT fix the 105. Publishing those tables would be the obvious move
 * and it is the dangerous one: `ALTER PUBLICATION ... ADD TABLE tournaments`
 * does not "switch realtime on", it switches on thirteen callbacks that have
 * never executed in production, at once, on a live poker platform. That is a
 * review per subscriber and a migration per table, not a line in a ticker PR.
 *
 * What it does is stop the number growing. The 105 are quarantined below by
 * file and table. A new subscription to an unpublished table fails this test,
 * and the author has to choose deliberately: publish the table in a migration
 * (and add it to `REALTIME_PUBLISHED_TABLES` in the same commit, having read
 * every existing subscriber), or use `realtime.send()` on a named channel,
 * which needs no publication and has no blast radius.
 *
 * The quarantine is a ratchet. When a dead subscription is deleted or its table
 * is published, remove its line. The count can only go down; a rise is the
 * regression this file exists to catch.
 *
 * ── KEEPING THE MANIFEST HONEST ────────────────────────────────────────────
 *
 * `REALTIME_PUBLISHED_TABLES` is a checked-in copy of something that lives in
 * the database, so it can drift. A test cannot reach production, so this law
 * cannot verify it; what it can do is make the drift cheap to detect, which is
 * why the query that produced it is written out above in full.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { globSync } from 'glob';
import { isRealtimePublished, REALTIME_PUBLISHED_TABLES } from './helpers/realtimePublishedTables';

const ROOT = resolve(__dirname, '..');

/**
 * Every `postgres_changes` subscription that exists today on a table realtime
 * does not publish: `[file, table, count]`.
 *
 * THE COUNT MATTERS. A file already carrying one dead subscription must not
 * quietly grow a second.
 */
const QUARANTINE: ReadonlyArray<readonly [string, string, number]> = [
  ['src/components/admin/AdminTableHeatmap.tsx', 'tables', 1],
  ['src/components/admin/ArenaLedger.tsx', 'audit_trail', 1],
  ['src/components/admin/ArenaLedger.tsx', 'messages', 1],
  ['src/components/admin/AuditLog.tsx', 'audit_trail', 1],
  ['src/components/agent/AgentCommissionDashboard.tsx', 'agent_commissions', 1],
  ['src/components/agent/AgentPromoPanel.tsx', 'agents', 1],
  ['src/components/bbj/BBJRecentHits.tsx', 'bbj_winners', 1],
  ['src/components/club/ClubChat.tsx', 'club_chat', 1],
  ['src/components/club/TableOperationsPanel.tsx', 'table_seats', 1],
  ['src/components/club/TableOperationsPanel.tsx', 'tables', 1],
  ['src/components/common/GlobalWaitlistListener.tsx', 'table_seats', 2],
  ['src/components/common/GlobalWaitlistListener.tsx', 'table_waitlist', 1],
  ['src/components/dashboard/ClubFinancialDashboard.tsx', 'club_diamond_wallets', 1],
  ['src/components/social/PresenceIndicator.tsx', 'profiles', 1],
  ['src/components/table/ThemeSettingsModal.tsx', 'theme_asset_unlocks', 1],
  ['src/components/tournament/TournamentClock.tsx', 'tournament_players', 1],
  ['src/components/tournament/TournamentHUD.tsx', 'tournaments', 1],
  ['src/components/tournament/details/RankingTab.tsx', 'tournament_players', 1],
  ['src/components/waitlist/WaitlistManager.tsx', 'table_waitlist', 1],
  ['src/components/wallet/CashoutRequestModal.tsx', 'cashout_requests', 1],
  ['src/components/wallet/DynamicWallet.tsx', 'agents', 1],
  ['src/components/wallet/DynamicWallet.tsx', 'clubs', 1],
  ['src/components/wallet/DynamicWallet.tsx', 'union_wallets', 1],
  ['src/components/wallet/WalletCashierModal.tsx', 'agents', 1],
  ['src/components/wallet/WalletCashierModal.tsx', 'clubs', 1],
  ['src/hooks/useMasterBusChannel.ts', '(no table key)', 1],
  ['src/hooks/useSeatedProfileSync.ts', 'profiles', 1],
  ['src/hooks/useTableStudioCollections.ts', 'user_table_studio_preferences', 1],
  ['src/hooks/useUserThemeSettings.ts', 'user_theme_settings', 1],
  ['src/lib/bbjHitFeed.ts', 'bbj_winners', 1],
  ['src/pages/AchievementsPage.tsx', 'training_user_achievements', 1],
  ['src/pages/AdminDashboardPage.tsx', 'audit_trail', 1],
  ['src/pages/AdminDashboardPage.tsx', 'cashout_requests', 1],
  ['src/pages/AdminDashboardPage.tsx', 'settlement_periods', 1],
  ['src/pages/AdminDashboardPage.tsx', 'tables', 1],
  ['src/pages/AdminDashboardPage.tsx', 'tournaments', 1],
  ['src/pages/AgentDashboardPage.tsx', 'cashout_requests', 1],
  ['src/pages/AgentDashboardPage.tsx', 'chip_transactions', 1],
  ['src/pages/AgentPortalPage.tsx', 'agent_commissions', 1],
  ['src/pages/AgentPortalPage.tsx', 'agents', 1],
  ['src/pages/AntiCheatPage.tsx', 'anti_cheat_events', 1],
  ['src/pages/AntiCheatPage.tsx', 'anti_cheat_flags', 1],
  ['src/pages/BadBeatJackpotPage.tsx', 'bbj_winners', 1],
  ['src/pages/CashierPage.tsx', 'chip_transactions', 2],
  ['src/pages/ClubAnnouncementsPage.tsx', 'club_announcements', 1],
  ['src/pages/ClubDetailPage.tsx', 'clubs', 1],
  ['src/pages/ClubDetailPage.tsx', 'tables', 1],
  ['src/pages/ClubHomePage.tsx', 'tables', 2],
  ['src/pages/ClubHomePage.tsx', 'tournaments', 2],
  ['src/pages/ClubRulesPage.tsx', 'clubs', 1],
  ['src/pages/ClubSettingsPage.tsx', 'clubs', 1],
  ['src/pages/CreditAdminPanel.tsx', 'agents', 1],
  ['src/pages/DisputeManagementPage.tsx', 'disputes', 1],
  ['src/pages/FinancialAdminHub.tsx', 'disputes', 1],
  ['src/pages/FinancialAlertsPage.tsx', 'financial_alerts', 1],
  ['src/pages/FlashPoolPage.tsx', 'flash_pools', 1],
  ['src/pages/MultiTablePage.tsx', 'table_seats', 1],
  ['src/pages/MultiTablePage.tsx', 'tournaments', 1],
  ['src/pages/PromotionsPage.tsx', 'promotions', 1],
  ['src/pages/RateAuditPage.tsx', 'commission_rate_audit', 1],
  ['src/pages/RateAuditPage.tsx', 'rake_rate_audit', 1],
  ['src/pages/SessionHistoryPage.tsx', 'session_history', 1],
  ['src/pages/SettlementDashboardPage.tsx', 'agent_commissions', 1],
  ['src/pages/SettlementHistoryPage.tsx', 'settlement_invoices', 1],
  ['src/pages/SettlementPage.tsx', 'agent_commissions', 1],
  ['src/pages/SettlementPage.tsx', 'settlement_invoices', 1],
  ['src/pages/SettlementPage.tsx', 'settlement_periods', 1],
  ['src/pages/SuperAgentDashboard.tsx', 'chip_transactions', 1],
  ['src/pages/TableConfigPage.tsx', 'table_templates', 1],
  ['src/pages/TablePage.tsx', 'table_seats', 2],
  ['src/pages/TablePage.tsx', 'tournament_players', 1],
  ['src/pages/TablePage.tsx', 'tournaments', 2],
  ['src/pages/TournamentPage.tsx', 'tournaments', 2],
  ['src/pages/TransactionHistoryPage.tsx', 'chip_transactions', 1],
  ['src/pages/UnionDashboardPage.tsx', 'union_admins', 1],
  ['src/pages/UnionDashboardPage.tsx', 'union_applications', 1],
  ['src/pages/UnionDashboardPage.tsx', 'union_clubs', 1],
  ['src/pages/UnionDashboardPage.tsx', 'union_wallets', 1],
  ['src/pages/UnionDashboardPage.tsx', 'unions', 1],
  ['src/pages/UnionDetailPage.tsx', 'tournaments', 1],
  ['src/pages/UnionDetailPage.tsx', 'union_clubs', 1],
  ['src/pages/UnionDetailPage.tsx', 'unions', 1],
  ['src/pages/UnionGamesPage.tsx', 'tournaments', 1],
  ['src/pages/tournament/TournamentDetails.tsx', 'tables', 1],
  ['src/pages/tournament/TournamentDetails.tsx', 'tournament_players', 1],
  ['src/pages/tournament/TournamentDetails.tsx', 'tournaments', 1],
  ['src/pages/tournament/TournamentResultsPage.tsx', 'tournament_players', 1],
  ['src/pages/tournament/TournamentResultsPage.tsx', 'tournaments', 1],
  ['src/services/AgentRakeService.ts', 'agent_commissions', 1],
  ['src/services/PostgresSyncHooks.ts', 'game_management_events', 1],
  ['src/services/PostgresSyncHooks.ts', 'profiles', 1],
  ['src/services/PostgresSyncHooks.ts', 'user_table_settings', 1],
  ['src/services/PostgresSyncHooks.ts', 'user_theme_settings', 2],
  ['src/services/PostgresSyncHooks.ts', 'wallets', 1],
  ['src/services/TableWebSocket.ts', 'table_chat', 1],
  ['src/stores/useHeaderDataStore.ts', 'messages', 1],
  ['src/stores/useHeaderDataStore.ts', 'profiles', 1],
];

/** `postgres_changes` config objects, and the `table:` each one names. */
const SUBSCRIPTION = /postgres_changes['"]?\s*,\s*\{(?<cfg>[^}]*)\}/gs;
const TABLE_KEY = /table:\s*['"](?<table>[A-Za-z0-9_]+)['"]/;

interface Site {
  file: string;
  table: string;
}

function everySubscription(): Site[] {
  const files = globSync('src/**/*.{ts,tsx}', { cwd: ROOT, nodir: true }).sort();
  const out: Site[] = [];
  for (const file of files) {
    const source = readFileSync(resolve(ROOT, file), 'utf8');
    for (const match of source.matchAll(SUBSCRIPTION)) {
      const cfg = match.groups?.cfg ?? '';
      out.push({ file, table: TABLE_KEY.exec(cfg)?.groups?.table ?? '(no table key)' });
    }
  }
  return out;
}

function countByFileAndTable(sites: Site[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const site of sites) {
    const key = `${site.file}::${site.table}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const ALL = everySubscription();
const DEAD = ALL.filter((site) => !isRealtimePublished(site.table));
const QUARANTINED = new Map(QUARANTINE.map(([file, table, count]) => [`${file}::${table}`, count]));

describe('LAW: a realtime subscription is to a published table', () => {
  it('finds subscriptions at all, so a silent regex failure cannot pass this law', () => {
    /* Every assertion below is "no NEW offenders". A regex that matched
       nothing would satisfy all of them while proving nothing at all. */
    expect(ALL.length).toBeGreaterThan(50);
    expect(ALL.some((site) => isRealtimePublished(site.table))).toBe(true);
  });

  it('adds no subscription to a table realtime does not publish', () => {
    const counts = countByFileAndTable(DEAD);
    const added: string[] = [];
    for (const [key, count] of counts) {
      const allowed = QUARANTINED.get(key) ?? 0;
      if (count > allowed) {
        added.push(
          `${key} - ${count} subscription(s), ${allowed} quarantined. ` +
            `That table is not in supabase_realtime, so this callback can never fire.`
        );
      }
    }
    expect(
      added,
      `\nA postgres_changes subscription to an unpublished table opens a channel that ` +
        `never delivers anything - silently, forever.\n\nPublished tables: ` +
        `${REALTIME_PUBLISHED_TABLES.join(', ')}\n\nEither publish the table in a ` +
        `migration (and read every existing subscriber to it first - see ` +
        `tests/helpers/realtimePublishedTables.ts), or push with realtime.send() on a named ` +
        `channel instead.\n\nNew offenders:\n${added.join('\n')}\n`
    ).toEqual([]);
  });

  it('keeps the quarantine a ratchet: no entry may be for something already fixed', () => {
    /* A stale quarantine line is worse than none. It reserves permission for a
       dead subscription that is no longer there, so the next one added in that
       file and table is waved straight through. */
    const counts = countByFileAndTable(DEAD);
    const stale: string[] = [];
    for (const [key, allowed] of QUARANTINED) {
      const actual = counts.get(key) ?? 0;
      if (actual < allowed) {
        stale.push(
          `${key} - quarantine says ${allowed}, source has ${actual}. Lower or remove it.`
        );
      }
    }
    expect(stale, `\nThe quarantine has drifted above the code:\n${stale.join('\n')}\n`).toEqual(
      []
    );
  });

  it('records the size of the debt, so shrinking it is visible', () => {
    /* 105 on 2026-09-14. This number is allowed to fall and nothing else. */
    expect(DEAD.length).toBeLessThanOrEqual(105);
  });

  it('never lets the ticker join them', () => {
    /* The bar polls. Phase 6 considered replacing that poll with a
       postgres_changes subscription on `tournaments` and found this instead:
       it would have been the fourteenth listener on a table that publishes
       nothing, and it would have LOOKED like it worked. */
    const ticker = ALL.filter((site) =>
      /components\/tournament\/Ticker|StartingTicker/.test(site.file)
    );
    for (const site of ticker) {
      expect(
        isRealtimePublished(site.table),
        `${site.file} subscribes to '${site.table}', which realtime does not publish.`
      ).toBe(true);
    }
  });
});
