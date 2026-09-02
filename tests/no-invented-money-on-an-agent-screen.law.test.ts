/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NO INVENTED MONEY ON AN AGENT OR CLUB SCREEN (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The audit pass after phase 7 of the agent credit and promotion lifecycle. The
 * phase itself repointed every surface that read a dropped object; this is what
 * the sweep afterwards found still standing, and every pin below is one of them.
 *
 *   1. ClubFinancialDashboard drew a pie labelled "Commission Split" from a
 *      HARDCODED constant - Club 50, Agents 30, Players 20. Not a default, not
 *      an estimate: three numbers that had never been measured, rendered beside
 *      real ones on a club owner's financials page. ClubFinancialsPage already
 *      carried a note about that page fabricating "rakeback as rake * 0.1 and
 *      agent commissions as rake * 0.05"; this was the last of that family.
 *
 *   2. AgentFinancialPortal's "Commission Trends" chart fed rake: 0 for every
 *      day, and FinancialChart drew the rake series unconditionally - so an
 *      agent saw a flat green Rake line at zero next to their real commission
 *      line. The downline rakes constantly; the chart simply had no rake data.
 *
 *   3. AgentDashboardPage's Commission History listed rows with no indication
 *      of whether they had been claimed. Before phase 6 there was no way to
 *      claim, so every row meant the same thing. There is now, and they do not.
 *
 *   4. Three dead objects were still named in places that shape behaviour or
 *      belief: two guard lists in the database, the phantom-table allowlist,
 *      and the RLS verification harness.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|--)/.test(line))
    .join('\n');

const CLUB_DASH = read('src/components/dashboard/ClubFinancialDashboard.tsx');
const CHART = read('src/components/charts/FinancialChart.tsx');
const AGENT_PORTAL = read('src/components/dashboard/AgentFinancialPortal.tsx');
const AGENT_DASH = read('src/pages/AgentDashboardPage.tsx');
const GUARDS = read(
  'supabase/migrations/20260901190748_two_guard_lists_named_a_dropped_function.sql'
);
const ALLOWLIST = read('scripts/ci/supabase-invariants.allowlist.json');
const HARNESS = read('scripts/verification-harness/01-rls-regression.sql');

describe('the club commission split is measured, not decided in advance', () => {
  it('has no hardcoded percentages left', () => {
    const code = codeOnly(CLUB_DASH);
    expect(code).not.toMatch(/name:\s*'Club',\s*value:\s*50/);
    expect(code).not.toMatch(/name:\s*'Agents',\s*value:\s*30/);
    expect(code).not.toMatch(/name:\s*'Players',\s*value:\s*20/);
  });

  it('reads all three shares from the ledgers that record them', () => {
    expect(CLUB_DASH).toMatch(/from\('rake_records'\)/);
    expect(CLUB_DASH).toMatch(/fn_club_commission_accrued/);
    expect(CLUB_DASH).toMatch(/transaction_type', 'rakeback'/);
  });

  it('divides by the rake, because commission books to a different club than rake does', () => {
    // credit_agent_commission_from_rake resolves the PLAYER's club; rake_records
    // records the TABLE's club. Dividing by (club+agents+players) draws "Agents
    // 100%" for any club whose members play at a host club's tables.
    expect(CLUB_DASH).toMatch(/totalRake <= 0\s*\?\s*EMPTY_SPLIT/);
    expect(CLUB_DASH).toMatch(/\(club \/ totalRake\)/);
    expect(CLUB_DASH).toMatch(/\(agents \/ totalRake\)/);
  });

  it('shows zero rather than a shape when the window holds no rake', () => {
    expect(CLUB_DASH).toMatch(/const EMPTY_SPLIT = \[/);
    expect(codeOnly(CLUB_DASH)).toMatch(/value: 0/);
  });
});

describe('a chart draws only the series it has data for', () => {
  it('the rake series is a choice', () => {
    expect(CHART).toMatch(/showRake\?: boolean/);
    expect(CHART).toMatch(/\{showRake && \(/);
  });

  it('and the agent commission chart turns it off, because it feeds zeros', () => {
    expect(AGENT_PORTAL).toMatch(/showRake=\{false\}/);
  });
});

describe('a commission row says whether it has been claimed', () => {
  it('the agent dashboard reads settled_at and renders it', () => {
    expect(AGENT_DASH).toMatch(/created_at, settled_at/);
    expect(AGENT_DASH).toMatch(/c\.settled_at \? 'Claimed' : 'Unclaimed'/);
  });

  it('and the CSV export carries the same fact', () => {
    expect(AGENT_DASH).toMatch(/key: 'settled_at', label: 'Claimed At'/);
  });
});

describe('nothing still points at the dropped objects', () => {
  it('the two remaining guard lists lost the dropped payout function', () => {
    expect(GUARDS).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_club_arena_global_wallet_check/);
    expect(GUARDS).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_union_overload_check/);
    expect(GUARDS).toMatch(
      /RAISE EXCEPTION 'a function still lists atomic_pay_agent_settlement by name'/
    );
    // The name survives only in the comment explaining its removal.
    expect(GUARDS).not.toMatch(/'atomic_pay_agent_settlement'\)/);
    expect(GUARDS).not.toMatch(/'atomic_pay_agent_settlement','fn_pay_player_chips'/);
  });

  it('the phantom-table allowlist no longer excuses tables that are gone', () => {
    // Their own entries said "UI cleanup pending" and "REMOVE THIS ENTRY when
    // that lands". It landed.
    expect(ALLOWLIST).not.toMatch(/"commission_records"/);
    expect(ALLOWLIST).not.toMatch(/"commission_history"/);
    expect(ALLOWLIST).not.toMatch(/"execute_commission_payout"/);
  });

  it('the RLS harness does not ask about a function that was dropped', () => {
    expect(HARNESS).not.toMatch(/'increment_agent_rake'/);
    expect(HARNESS).toMatch(/increment_agent_rake was here/);
  });
});
