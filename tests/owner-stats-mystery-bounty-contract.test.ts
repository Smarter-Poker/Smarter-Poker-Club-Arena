import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const migrationPath =
  'supabase/migrations/20261006032934_owner_stats_keeps_mystery_bounty_truth.sql';

describe('owner Stats mystery-bounty contract', () => {
  it('replaces the exact latest owner RPC preimage and proves the derived postimage', () => {
    const source = read(
      'supabase/migrations/20261003132118_stats_preserve_authorized_club_scope.sql'
    );
    const migration = read(migrationPath);
    const functionStart = source.indexOf(
      'CREATE OR REPLACE FUNCTION public.ca_player_stats_overview_v2(\n'
    );
    const bodyStart = source.indexOf('AS $function$', functionStart) + 'AS $function$'.length;
    const bodyEnd = source.indexOf('$function$;', bodyStart);
    const preimage = source.slice(bodyStart, bodyEnd);
    const oldFragment = migration.match(/v_old constant text := \$old\$([\s\S]*?)\$old\$;/)?.[1];
    const newFragment = migration.match(/v_new constant text := \$new\$([\s\S]*?)\$new\$;/)?.[1];

    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(oldFragment).toBeTruthy();
    expect(newFragment).toBeTruthy();
    expect(preimage.split(oldFragment!).length - 1).toBe(1);
    expect(createHash('md5').update(preimage).digest('hex')).toBe(
      'bd728d2f93005ced4b50693985febec2'
    );
    expect(migration).toContain("md5(v_definition) <> 'e72c0a6a917eb81e79ac5a7043a9db14'");

    const postimage = preimage.replace(oldFragment!, newFragment!);
    expect(createHash('md5').update(postimage).digest('hex')).toBe(
      '9e5167ac7815b7dcb8469ac51238242e'
    );
    expect(postimage).toContain('coalesce(t.is_mystery_bounty,false) is_mystery_bounty');
    expect(postimage).toContain('coalesce(tp.bounties_collected,0) bounties');
    expect(postimage).toContain('coalesce(tp.prize,0)+coalesce(tp.bounty_winnings,0) total_won');
    expect(postimage).toContain(
      'CASE WHEN tp.add_on THEN coalesce(t.addon_cost,0) ELSE 0 END buyin'
    );
  });

  it('preserves the function authority and refuses drift instead of broadening access', () => {
    const migration = read(migrationPath);

    expect(migration).toContain("pg_get_userbyid(v_owner) <> 'postgres'");
    expect(migration).toContain(
      "v_acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}'"
    );
    expect(migration).toContain('p.proacl::text IS NOT DISTINCT FROM v_acl');
    expect(migration).toContain('p.prosecdef = v_security_definer');
    expect(migration).toContain('p.provolatile = v_volatility');
    expect(migration).toContain('p.proconfig::text IS NOT DISTINCT FROM v_config');
    expect(migration).toContain("has_function_privilege('anon', v_sig, 'EXECUTE')");
    expect(migration).not.toMatch(/\bGRANT\s+(?:ALL|EXECUTE)\b/i);
  });

  it('requires complete v2 recent-event money fields and discloses the analysis cap separately', () => {
    const validator = read('src/pages/stats/playerStatsPageModel.tsx');
    const headline = read('src/pages/stats/StatsHeadlineDeck.tsx');
    const types = read('src/pages/stats/types.ts');

    expect(validator).toContain(
      "allFinite(row, ['prize', 'bounty_winnings', 'total_won', 'buyin'])"
    );
    expect(validator).toContain("allCounts(row, ['bounties'])");
    expect(validator).toContain("typeof row.is_mystery_bounty !== 'boolean'");
    expect(validator).toContain('exactCentSum(row.total_won, row.prize, row.bounty_winnings)');
    expect(headline).toContain('Analysis Panels Use Your Most Recent');
    expect(headline).toContain('Headline Totals Still');
    expect(types).toContain('Headline totals are unbounded');
  });
});
