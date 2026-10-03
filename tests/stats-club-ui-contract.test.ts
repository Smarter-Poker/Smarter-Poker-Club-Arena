import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readStatsDrilldown } from '../src/lib/handHistoryDrilldown';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Player Stats authorized club UI contract', () => {
  const page = read('src/pages/PlayerStatsPage.tsx');
  const model = read('src/pages/stats/playerStatsPageModel.tsx');
  const clubScopeConsole = read('src/pages/stats/ClubScopeConsole.tsx');

  it('uses a separate URL key and restores club, range, tab, and sort from URL changes', () => {
    expect(page).toContain("searchParams.get('statsClub')");
    expect(page).toContain("current.get('range')");
    expect(page).toContain("current.get('tab')");
    expect(page).toContain("current.get('clubSort')");
    expect(page).toContain('const searchKey = searchParams.toString()');
    expect(page).toContain('updateStatsUrl({ statsClub: nextClubId })');
    expect(page).toContain(
      "updateStatsUrl({ range: nextRangeKey === 'all' ? null : nextRangeKey })"
    );
    expect(page).toContain(
      "updateStatsUrl({ tab: nextCategory === 'overview' ? null : nextCategory })"
    );
  });

  it('keys caches and stale-response guards by the selected club', () => {
    expect(page).toContain('const cacheIdentityFor = useCallback');
    expect(page).toContain('contractVersion: STATS_CACHE_CONTRACT_VERSION');
    expect(page).toContain('activeClubIdRef.current !== selectedClubId');
    expect(page).toContain("const loadScopeKey = `${selectedClubId ?? 'all'}:${rangeKey}`");
    expect(page).toContain('clubId: selectedClubId');
  });

  it('loads comparison once with the bounded comparison RPC and exposes every required sort', () => {
    expect(page).toContain("supabase.rpc('ca_player_stats_club_comparison'");
    expect(page).toContain('p_tz: statsTimezone');
    expect(page).not.toContain('clubs.map(async (club)');
    for (const key of [
      'club',
      'hands',
      'profit',
      'bb100',
      'vpip',
      'pfr',
      'hours',
      'rake',
      'tournaments',
      'lastPlay',
    ]) {
      expect(model).toContain(`key: '${key}'`);
    }
    expect(clubScopeConsole).toContain("row.hours === null ? 'Unavailable'");
  });

  it('propagates club scope to overview, facts, notable hands, pulse, and exports', () => {
    expect(page).toContain("statsRpcName('ca_player_stats_overview_v2', selectedClubId)");
    expect(page).toContain("statsRpcName('ca_player_hands_v2', selectedClubId)");
    expect(page).toContain('StatsFactsService, statsScope, windowDays, selectedClubId');
    expect(page).toContain('clubId={selectedClubId}');
    expect(page).toContain("params.set('statsClub', selectedClubId)");
    expect(page).toContain("selectedClubId ?? 'all_clubs'");
  });

  it('carries the selected club into the server-filtered Hand History receiver', () => {
    expect(readStatsDrilldown(new URLSearchParams('statsClub=club-7'))).toMatchObject({
      clubId: 'club-7',
    });
    const history = read('src/pages/HandHistoryPage.tsx');
    expect(history).toContain('clubId: statsDrilldown.clubId');
  });
});
