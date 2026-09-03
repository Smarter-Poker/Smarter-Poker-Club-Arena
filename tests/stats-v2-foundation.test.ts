import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const MIGRATION = readFileSync(
  resolve(ROOT, 'supabase/migrations/20260831235995_stats_v2_foundation.sql'),
  'utf8'
);
const BOUNDED_MIGRATION = readFileSync(
  resolve(ROOT, 'supabase/migrations/20260831235998_stats_v2_reads_bounded_rollup.sql'),
  'utf8'
);
const PAGE = readFileSync(resolve(ROOT, 'src/pages/PlayerStatsPage.tsx'), 'utf8');
const ROUTER = readFileSync(resolve(ROOT, 'server/src/router.ts'), 'utf8');
const PUBLIC_PROFILE = readFileSync(resolve(ROOT, 'src/pages/PublicProfilePage.tsx'), 'utf8');
const PROFILE_SERVICE = readFileSync(resolve(ROOT, 'src/services/ProfileService.ts'), 'utf8');
const ADVANCED_SUMMARY = readFileSync(
  resolve(ROOT, 'src/components/stats/AdvancedStatsSummary.tsx'),
  'utf8'
);
const PRODUCTION_SPEC = readFileSync(resolve(ROOT, 'tests/e2e/stats-deep.spec.ts'), 'utf8');
const PROFILE = readFileSync(resolve(ROOT, 'src/pages/ProfilePage.tsx'), 'utf8');
const NEMESIS = readFileSync(resolve(ROOT, 'src/components/stats/NemesisPanel.tsx'), 'utf8');

function sqlFunctionBody(sql: string, signature: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${signature}`);
  expect(start, `${signature} definition`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('$function$;', start);
  expect(end, `${signature} terminator`).toBeGreaterThan(start);
  return sql.slice(start, end + '$function$;'.length);
}

describe('Stats contract v2 security boundary', () => {
  it('makes the browser use only owner-asserting versioned RPCs', () => {
    expect(PAGE).toContain("rpc('ca_player_stats_overview_v2'");
    expect(PAGE).toContain("rpc('ca_player_hands_v2'");
    expect(PAGE).not.toContain("rpc('ca_player_stats_full'");
    expect(PAGE).not.toContain("rpc('ca_player_hands'");

    expect(sqlFunctionBody(MIGRATION, 'ca_player_stats_overview_v2')).toContain(
      'PERFORM public.ca_assert_self(p_user)'
    );
    expect(sqlFunctionBody(MIGRATION, 'ca_player_hands_v2')).toContain(
      'PERFORM public.ca_assert_self(p_user)'
    );
  });

  it('revokes both arbitrary-target legacy functions from browser roles', () => {
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.ca_player_stats_full\(uuid, integer\)[\s\S]{0,100}PUBLIC, anon, authenticated;/
    );
    expect(MIGRATION).toMatch(
      /REVOKE ALL ON FUNCTION public\.ca_player_hands\(uuid, text, integer\)[\s\S]{0,100}PUBLIC, anon, authenticated;/
    );
    expect(MIGRATION).toContain('legacy arbitrary-target Stats RPC remains reachable');
  });

  it('does not hydrate or request cross-profile statistics', () => {
    expect(PAGE).toContain('if (!targetUserId || !isOwnProfile) return;');
    expect(PAGE).toContain('Player Stats Are Private');
    expect(PAGE).toContain('No All-Club Financial');
    expect(PUBLIC_PROFILE).not.toContain('profileService.getStats');
    expect(PUBLIC_PROFILE).not.toContain('ProfileStats');
    expect(PROFILE_SERVICE).not.toContain("rpc('ca_player_stats_overview_v2'");
    expect(ADVANCED_SUMMARY).not.toContain('userId?: string');
    expect(ADVANCED_SUMMARY).not.toContain('if (userId) return userId');
  });

  it('does not retrieve private aggregate fields in a public profile query', () => {
    const publicQuery = PROFILE_SERVICE.match(
      /async getPublicProfile[\s\S]*?\.select\([\s\S]*?\)\s*\.eq\('id'/
    )?.[0];
    expect(publicQuery).toBeTruthy();
    expect(publicQuery).not.toContain('total_hands_played');
    expect(publicQuery).not.toContain('diamonds');
    expect(publicQuery).not.toContain('login_streak');
    expect(publicQuery).not.toContain('streak_days');
  });

  it('contains no retained fake Stats dashboard stub', () => {
    expect(existsSync(resolve(ROOT, 'src/components/stats/PlayerStatsDashboard.tsx'))).toBe(false);
    expect(existsSync(resolve(ROOT, 'src/components/stats/PlayerStatsDashboard.css'))).toBe(false);
    expect(PROFILE).toContain("rpc('ca_player_stats_overview_v2'");
    expect(PROFILE).toContain('statsAvailable ?');
    expect(PROFILE).toContain('Stats Snapshot Unavailable');
  });

  it('routes rival actions to profiles while cross-player Stats remains private', () => {
    expect(NEMESIS).toContain('navigate(`/profile/${id}`)');
    expect(NEMESIS).not.toContain('navigate(`/stats/${id}`)');
  });

  it('certifies the expensive production rollup without a parallel cold-start stampede', () => {
    expect(PRODUCTION_SPEC).toContain("mode: 'serial'");
    expect(PRODUCTION_SPEC).toContain('timeout: 90_000');
    expect(PRODUCTION_SPEC).toContain("name: 'Overview'");
  });
});

describe('Stats truth and reproducibility boundary', () => {
  it('records missing production index and rake definitions in a normal migration', () => {
    expect(MIGRATION).toContain('CREATE TABLE IF NOT EXISTS public.ca_hand_player_idx');
    expect(MIGRATION).toContain('FUNCTION public.ca_refresh_hand_player_index');
    expect(MIGRATION).toContain('FUNCTION public.ca_player_rake_stats');
    expect(MIGRATION).toContain('FUNCTION public.ca_player_hand_rake_share');
  });

  it('returns explicit source quality and coverage metadata', () => {
    expect(MIGRATION).toContain("'contract_version', 2");
    expect(MIGRATION).toContain("'cash_money_source', 'reconstructed_actions'");
    expect(MIGRATION).toContain("'cash_money_exact', false");
    expect(MIGRATION).toContain("'historical_club_breakdown_available', false");
    expect(PAGE).toContain('Cash Result And BB/100 Use Reconstructed Hand Actions');
    expect(BOUNDED_MIGRATION).toContain("'advanced_facts_source', 'ca_hand_player_stat'");
    expect(BOUNDED_MIGRATION).toContain("'live_tail_included', false");
    expect(BOUNDED_MIGRATION).toContain("'rollup_covered_through', to_jsonb(v_rollup_ceil)");
    expect(PAGE).toContain('Newer Hands Appear After The Next Stats Rollup');
  });

  it('never substitutes legacy player_stats rows under a scoped range label', () => {
    expect(PAGE).not.toContain('loadLegacyStats');
    expect(PAGE).not.toContain('legacy_fallback');
    expect(PAGE).toContain('loadedRangeKeyRef.current === rangeKey');
    expect(PAGE).toContain('onClick={() => changeRange(r.key)}');
    expect(PAGE).toContain('.call(StatsFactsService, windowDays)');
  });
});

describe('false Assistant integration is absent', () => {
  it('has no client call, success claim, or engine route', () => {
    expect(PAGE).not.toContain('/assistant/leaks/detect');
    expect(PAGE).not.toContain('sent to your Personal Assistant');
    expect(ROUTER).not.toContain('/assistant/leaks/detect');
    expect(ROUTER).not.toContain('handleAssistantLeaksDetect');
  });
});
