/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE OVERVIEW RPC AND THE PAGE THAT READS IT AGREE ON EVERY KEY
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-03)
 *
 * `get_anti_cheat_stats` returns `total_hands_analyzed`, `flagged_players`,
 * `active_investigations`, `collusion_alerts`, `bot_suspicions`,
 * `chip_dumping_alerts` and `last_scan`. AntiCheatPage reads `open_flags`,
 * `blocks_24h`, `active_sessions`, `by_severity` and `by_type`. Not one key
 * matches. `fmt(undefined)` renders "0", so the page has always shown a club
 * six zeros and the words "Club Is Clean", and nothing anywhere went red.
 *
 * A payload contract that lives only in two people's heads gets broken by the
 * next migration. This pins the new one from both ends: every key the SQL
 * returns must be read somewhere in the client, and every tool id the SQL
 * routes an alert to must exist in the navigation registry.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getClubNavigationCapabilities } from '../../src/config/clubArenaNavigation';
import { getClubOperationItems } from '../../src/config/clubOperationsNavigation';

const MIGRATION =
  'supabase/migrations/20260903160000_the_operations_page_reads_the_club_it_governs.sql';
const SQL = readFileSync(MIGRATION, 'utf8');
const HOOK = readFileSync('src/hooks/useClubOperationsOverview.ts', 'utf8');
const MANIFEST = readFileSync('scripts/ci/schema-manifest.d/cowork-ops-upgrade.json', 'utf8');

/** The keys of one jsonb_build_object block, read off the migration itself so
 *  a key added to the SQL is a key this suite immediately demands a reader
 *  for. Anchored at line starts, so only `'key', value` lines match. */
function keysIn(startMarker: string, endMarker: string): string[] {
  const start = SQL.indexOf(startMarker);
  expect(start, `${startMarker} is missing from the migration`).toBeGreaterThan(-1);
  const from = start + startMarker.length;
  const end = SQL.indexOf(endMarker, from);
  expect(end, `${endMarker} does not close ${startMarker}`).toBeGreaterThan(from);
  return [...SQL.slice(from, end).matchAll(/^\s*'([a-z0-9_]+)',/gm)].map((match) => match[1]);
}

describe('the operations overview function is gated, granted, and declared', () => {
  it('refuses a caller who is not staff of this club', () => {
    expect(SQL).toContain("RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501'");
    expect(SQL).toContain("v_role IN ('owner', 'co_owner', 'admin', 'super_agent', 'agent')");
  });

  it('does not reach for the auth.uid() IS NULL shortcut its neighbours use', () => {
    // `auth.uid() IS NULL OR ...` reads as "internal caller" and means "anyone
    // with no user". ca_can_view_club and ca_can_view_club_finances both open
    // with it, and the only thing between anon and their answer is the EXECUTE
    // grant. This function names its internal escape instead.
    expect(SQL).not.toMatch(/auth\.uid\(\)\s+IS\s+NULL\s+OR/i);
    expect(SQL).toContain("session_user IN ('postgres', 'supabase_admin')");
    expect(SQL).toContain("coalesce(auth.role(), '') = 'service_role'");
  });

  it('is executable by a signed-in operator and by nobody anonymous', () => {
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION public.ca_club_operations_overview(uuid) FROM anon'
    );
    expect(SQL).toContain(
      'GRANT EXECUTE ON FUNCTION public.ca_club_operations_overview(uuid) TO authenticated'
    );
    expect(SQL).toContain(
      'GRANT EXECUTE ON FUNCTION public.ca_club_operations_overview(uuid) TO service_role'
    );
    expect(SQL).toMatch(/SECURITY DEFINER/);
    expect(SQL).toMatch(/SET search_path TO 'public'/);
  });

  it('declares itself to the schema gates so CI knows it exists', () => {
    expect(JSON.parse(MANIFEST).functions).toContain('ca_club_operations_overview');
  });

  it('counts every player, including the simulated ones', () => {
    // CLAUDE.md 10.5. A count that drops horses is a count of nothing in this
    // estate: 416 of the 417 members of the largest club are horses.
    expect(SQL).not.toMatch(/is_horse/);
  });

  it('keeps the money figures inside the finance branch', () => {
    const financeBranch = SQL.slice(SQL.lastIndexOf('IF v_finance THEN'));
    for (const key of ['rake_today', 'club_bank', 'member_chips']) {
      expect(financeBranch).toContain(`'${key}'`);
    }
    const staffKpis = SQL.slice(
      SQL.indexOf('v_kpis := jsonb_build_object('),
      SQL.lastIndexOf('IF v_finance THEN')
    );
    for (const key of ['rake_today', 'club_bank', 'member_chips']) {
      expect(staffKpis).not.toContain(`'${key}'`);
    }
  });
});

const KPI_KEYS = [
  ...keysIn('v_kpis := jsonb_build_object(', ');'),
  ...keysIn('v_kpis := v_kpis || jsonb_build_object(', ');'),
];
const COUNT_KEYS = keysIn("'counts', jsonb_build_object(", "'alerts'");

describe('every key the function returns is read by the client', () => {
  it('found the payload blocks, so this suite is not vacuous', () => {
    expect(KPI_KEYS.length).toBeGreaterThanOrEqual(14);
    expect(COUNT_KEYS.length).toBeGreaterThanOrEqual(14);
  });

  it.each(KPI_KEYS)('kpi %s is read by the hook', (key) => {
    expect(HOOK.includes(`kpis.${key}`)).toBe(true);
  });

  it.each(COUNT_KEYS)('count %s is read by the hook', (key) => {
    expect(HOOK.includes(`counts.${key}`)).toBe(true);
  });
});

describe('every alert routes to a tool that exists', () => {
  const registry = getClubOperationItems(
    'sample-club',
    getClubNavigationCapabilities(null, true)
  ).map((item) => item.id);
  const tools = [...SQL.matchAll(/'tool',\s*'([a-z0-9-]+)'/g)].map((match) => match[1]);
  const severities = [...SQL.matchAll(/'severity',\s*'([a-z]+)'/g)].map((match) => match[1]);

  it('raises alerts at all, so this suite is not vacuous', () => {
    expect(tools.length).toBeGreaterThanOrEqual(10);
  });

  it.each([...new Set(tools)])('%s is a registry tool id', (tool) => {
    expect(registry).toContain(tool);
  });

  it('uses only severities the client knows how to paint', () => {
    for (const severity of new Set(severities)) {
      expect(['critical', 'warning', 'info']).toContain(severity);
    }
  });
});
