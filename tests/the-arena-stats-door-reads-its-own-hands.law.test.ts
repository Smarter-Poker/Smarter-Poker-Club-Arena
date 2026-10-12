/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - THE ARENA'S STATS DOOR READS ITS OWN HANDS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 10 of the Diamond Arena programme, line 1. The Diamond footer's Stats
 * door opens /stats?club=diamond-arena, and the stats page used to read chips
 * whatever door it came from, so a player in the arena was shown their chip
 * figures under the Diamond footer - and the Rake tab's agent downline beside
 * them, in an arena that has no agents. The page now takes its asset from the
 * arena it was opened from, every read names it, its caches are keyed by it,
 * the panels and the pulse are handed it, and the Hands tab's reader learned
 * the asset in 20260929213851 (ca_player_hands and ca_player_hands_v2).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationNames, migrationText } from './helpers/migrationCorpus';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '');

const PAGE = code(read('src/pages/PlayerStatsPage.tsx'));

describe("LAW: the arena's Stats door reads its own hands", () => {
  it('the Diamond footer opens the stats page with the arena as its club', async () => {
    const { DIAMOND_FOOTER_DOORS } = await import('../src/components/arena/DiamondBottomNav');
    const stats = DIAMOND_FOOTER_DOORS.find((d) => d.key === 'stats');
    expect(stats?.to).toBe('/stats?club=diamond-arena');
  });

  it('the page takes its asset from the arena it was opened from', async () => {
    const { statsScopeForSearch } = await import('../src/pages/stats/arenaStatsScope');
    expect(statsScopeForSearch('?club=diamond-arena')).toBe('diamonds');
    expect(statsScopeForSearch('?club=002c2d27-9584-4e52-835a-bb2be148fc81')).toBe('diamonds');
    expect(statsScopeForSearch('?club=deep-stack-society')).toBe('chips');
    expect(statsScopeForSearch('')).toBe('chips');
    expect(PAGE).toContain(
      'const { scope: statsScope, eyebrow: statsEyebrow } = useArenaStatsScope();'
    );
  });

  it('every read on the page names that asset, and none names chips by hand', () => {
    expect(PAGE).not.toMatch(/statsScopeArgs\(\s*CHIP_STATS\s*\)/);
    expect(PAGE).not.toMatch(/\.call\(\s*StatsFactsService\s*,\s*CHIP_STATS/);
    expect(PAGE.split('...statsScopeArgs(statsScope, selectedClubId)').length - 1).toBe(3); // windowed, all-time, hands
    expect(PAGE).toContain('.call(StatsFactsService, statsScope, windowDays, selectedClubId)');
    expect(PAGE).toMatch(/useStatsPulse\(\{[\s\S]*?scope: statsScope,[\s\S]*?\}\);/);
    for (const tab of ['OverviewTab', 'PerformanceTab', 'HandsTab']) {
      expect(PAGE, `${tab} is handed the asset`).toMatch(
        new RegExp(`<${tab}\\s+scope=\\{statsScope\\}`)
      );
    }
    expect(PAGE).toMatch(
      /statsRpcName\('ca_player_hands_v2', selectedClubId\)[\s\S]*?\.\.\.statsScopeArgs\(statsScope, selectedClubId\)/
    );
  });

  it('neither asset can be served from the other one’s cache', () => {
    expect(PAGE).toContain("getCachedFull(cacheIdentityFor('all', null))");
    expect(PAGE).toContain('setCachedFull(cacheIdentityFor(rangeKey, windowDays), data)');
    expect(PAGE).toContain('readStatsRangeMemo(cacheIdentityFor(rangeKey, windowDays))');
    expect(PAGE).toContain("readStatsRangeMemo(cacheIdentityFor('all', null))");
    expect(PAGE).toContain('asset: statsScope');
    expect(PAGE).toContain('timezone: statsTimezone');
  });

  it('the arena page shows no agent downline', () => {
    expect(PAGE).toContain('if (!isOwnProfile || !user?.id || statsScope !== CHIP_STATS) {');
  });

  it('the panels and the pulse read the asset they are handed', () => {
    const panels: Array<[string, RegExp]> = [
      ['src/components/stats/NemesisPanel.tsx', /getNemesis\(userId, scope,/],
      ['src/components/stats/EVLuckChart.tsx', /getEVCurve\(userId, scope,/],
      ['src/components/stats/HoleCardHeatmap.tsx', /getHandGrid\(userId, scope,/],
      ['src/components/stats/HoleCardHeatmap.tsx', /getClassHands\(\s*userId,\s*scope,/],
      ['src/hooks/useStatsPulse.ts', /\.\.\.statsScopeArgs\(scope, clubId\)/],
    ];
    for (const [file, re] of panels) expect(code(read(file)), file).toMatch(re);
    for (const file of [
      'src/components/stats/NemesisPanel.tsx',
      'src/components/stats/EVLuckChart.tsx',
      'src/components/stats/HoleCardHeatmap.tsx',
    ]) {
      expect(code(read(file)), `${file} names no asset by hand`).not.toMatch(
        /StatsFactsService\.\w+\(userId, CHIP_STATS/
      );
    }
  });

  it('the Hands tab reader takes the asset, pinned and reversible', () => {
    const name = migrationNames()
      .filter((n) => n.endsWith('_the_arena_stats_door_reads_its_own_hands.sql'))
      .at(-1);
    expect(name).toBeTruthy();
    const sql = migrationText(name!);
    for (const [fn, oldSig] of [
      ['ca_player_hands', 'ca_player_hands(uuid, text, integer)'],
      ['ca_player_hands_v2', 'ca_player_hands_v2(uuid, text, integer)'],
    ]) {
      expect(sql).toContain(`DROP FUNCTION public.${oldSig};`);
      expect(sql).toMatch(
        new RegExp(
          `\\$f\\$CREATE OR REPLACE FUNCTION public\\.${fn}\\([^\\n]*, p_asset text DEFAULT 'chips'::text\\)`
        )
      );
    }
    expect((sql.match(/IF md5\(v_def\) <> '[0-9a-f]{32}' THEN/g) ?? []).length).toBe(2);
    expect(sql).toContain('    AND s.asset = p_asset\n');
    expect(sql).toContain('  RETURN public.ca_player_hands(p_user, p_mode, p_limit, p_asset);');
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.ca_player_hands_v2(uuid, text, integer, text) TO authenticated, service_role;'
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.ca_player_hands(uuid, text, integer, text) TO service_role;'
    );
  });
});
