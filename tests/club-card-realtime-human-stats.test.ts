import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const home = readFileSync(resolve(root, 'src/pages/HomePage.tsx'), 'utf8');
const card = readFileSync(resolve(root, 'src/components/home/CarouselSection.tsx'), 'utf8');
const sql = readFileSync(
  resolve(root, 'supabase/migrations/20260901090000_club_card_human_realtime_stats.sql'),
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
});
