import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLUB_LEVEL_THRESHOLDS } from '../src/utils/clubLevels';

const root = resolve(__dirname, '..');
const home = readFileSync(resolve(root, 'src/pages/HomePage.tsx'), 'utf8');
const card = readFileSync(resolve(root, 'src/components/home/CarouselSection.tsx'), 'utf8');
const sql = readFileSync(
  resolve(root, 'supabase/migrations/20260901090000_club_card_human_realtime_stats.sql'),
  'utf8'
);
const unionSql = readFileSync(
  resolve(
    root,
    'supabase/migrations/20260903184634_union_active_players_is_the_sum_of_its_clubs.sql'
  ),
  'utf8'
);

describe('Club Arena card statistics', () => {
  it('reads live membership and activity RPCs', () => {
    expect(home).toContain("rpc('fn_batch_club_realtime_member_counts'");
    expect(home).toContain("rpc('fn_batch_club_realtime_active_counts'");
    expect(home).toContain("rpc('fn_batch_union_realtime_member_counts'");
    expect(home).toContain("rpc('fn_batch_union_realtime_active_counts'");
    expect(sql).toContain('fn_get_club_realtime_member_count');
  });

  it('never falls back to stale columns or cached stats', () => {
    expect(card).toContain('totalMembers={stats?.totalMembers ?? null}');
    expect(card).toContain('activePlayers={stats?.activePlayers ?? null}');
    expect(home).not.toContain('localStorage.setItem(STORAGE_KEYS.CLUB_STATS_CACHE');
    expect(home).not.toContain('localStorage.getItem(STORAGE_KEYS.CLUB_STATS_CACHE');
    expect(home).toContain('const activePlayers = activeCountMap.get(club.id) ?? null');
    expect(home).not.toContain("rpc('recompute_club_levels'");
  });

  it('counts every legitimate member equally instead of hiding account classes', () => {
    const realtimeFunctions = sql.slice(0, sql.indexOf('-- Keep the denormalised column'));
    expect(realtimeFunctions).not.toContain('is_horse');
    expect(sql).not.toMatch(/UPDATE\s+public\.profiles/i);
    expect(sql).toContain('t.club_id = requested.club_id');
    expect(sql).toContain('t.club_id = uc.club_id');
    expect(sql).toContain('level = public.fn_club_level_for_members(v_count::integer)');
  });

  it('a union card shows the sum of its clubs, not a de-duplicated head count', () => {
    const fn = unionSql.slice(
      unionSql.indexOf('fn_batch_union_realtime_active_counts(p_union_ids uuid[])'),
      unionSql.indexOf('fn_union_active_player_counts')
    );
    expect(fn).toContain('public.fn_batch_club_realtime_active_counts(');
    expect(fn).toContain('sum(pc.active_count)');
    expect(fn).not.toContain('count(DISTINCT ts.user_id)');
    expect(unionSql).toContain('is not the sum of its clubs');
  });

  it('every union the service hands out carries live counts, not stale columns or estimates', () => {
    const svc = readFileSync(resolve(root, 'src/services/UnionService.ts'), 'utf8');
    const detail = readFileSync(resolve(root, 'src/pages/UnionDetailPage.tsx'), 'utf8');

    // one enricher, wired into every reader
    expect(svc).toContain("rpc('fn_batch_union_realtime_member_counts'");
    expect(svc).toContain("rpc('fn_batch_union_realtime_active_counts'");
    expect(svc.match(/enrichWithRealtimeCounts\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);

    // the things that made the number wrong
    expect(svc).not.toContain('u.online_count'); // column does not exist
    expect(svc).not.toMatch(/Math\.floor\([^)]*\*\s*0\.2\)/); // the 20% "online" estimate
    expect(svc).not.toContain('Math.max(liveCount');
    expect(svc).not.toContain("rpc('fn_batch_club_member_counts'"); // omits empty clubs
    expect(detail).not.toContain('unionData.memberCount = unionData.totalPlayers');
  });

  it('one ladder and one count are written by one trigger for every club and union', () => {
    const ladder = readFileSync(
      resolve(
        root,
        'supabase/migrations/20260903191338_one_ladder_one_count_for_every_club_and_union.sql'
      ),
      'utf8'
    );
    expect(ladder).toContain('fn_apply_club_ladder');
    expect(ladder).toContain('fn_apply_union_ladder');
    expect(ladder).toContain('fn_get_club_realtime_member_count(p_club_id)');
    expect(ladder).toContain('fn_batch_union_realtime_member_counts(ARRAY[p_union_id])');
    expect(ladder).toContain('trg_new_club_gets_the_ladder');
    expect(ladder).toContain('trg_new_union_gets_the_ladder');
    expect(ladder).toContain('retired 2026-09-03');
    // 55 rungs, TS and SQL agree
    const rungs = [...ladder.matchAll(/\((\d+),(\d+),'[a-z]+','[^']+'\)/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    expect(rungs.length).toBe(55);
    rungs.forEach(([level, min]) => expect(CLUB_LEVEL_THRESHOLDS[level - 1]).toBe(min));
  });
});
