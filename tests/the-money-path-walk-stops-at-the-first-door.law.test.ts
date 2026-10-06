/**
 * LAW: THE MONEY PATH WALK STOPS AT THE FIRST DOOR (2026-10-03).
 *
 * fn_union_law_selftest timed out on 10-01 and 10-02. Its money-path half
 * spent 25 to 51 s in fn_money_path_reaches_club_scope. That function was a
 * recursive CTE over (name, depth): it expanded a name again at every depth
 * it was reached at, and it built the whole call graph before EXISTS could
 * answer.
 *
 * The successor is a breadth-first walk with a visited set, and it returns at
 * the first function that touches club scope. Reachability within the depth
 * limit is the same set, so the answers are the same: 12/12 money paths and
 * 54/54 random production cases, plus 108/108 cases on a PG17 graph built to
 * break it. The 12 paths now take 4.4 s instead of 45.9 s.
 *
 * What this pins: the walk never revisits a name, it stops at the first door,
 * it still treats only a real call (name followed by "(") of a name longer
 * than six characters as an edge, and it still finds club_members or
 * fn_pay_player_chips as the door. The caller still asks for depth 6.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const MIG = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261003103506_the_money_path_walk_stops_at_the_first_door.sql'
  ),
  'utf8'
);
const fnStart = MIG.indexOf('CREATE OR REPLACE FUNCTION public.fn_money_path_reaches_club_scope(');
const fnEnd = MIG.indexOf('$function$;', fnStart);
const FN = MIG.slice(fnStart, fnEnd) + '$function$\n';
const code = FN.replace(/--[^\n]*/g, ' ');

describe('the money path walk stops at the first door', () => {
  it('is one pinned transaction whose live proof is the declared text', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("SET LOCAL lock_timeout = '5s';");
    const md5 = createHash('md5').update(FN).digest('hex');
    expect(md5).toBe('f9f43589929fdfd1cc356eaa67943785');
    expect(MIG).toContain(`= '${md5}')`);
    expect(MIG).toContain("IS DISTINCT FROM '0187859a2c1b519dd3044da87504eaab'");
    for (const c of ['PREIMAGE_CHANGED', 'AUTHORITY_CHANGED', 'RESULT_CHANGED'])
      expect(MIG).toContain('MONEY_PATH_WALK_' + c);
    expect(MIG).toContain('IF EXISTS (SELECT 1 FROM public.fn_union_money_path_check()) THEN');
  });

  it('walks each name once and stops at the first door', () => {
    expect(code).not.toMatch(/WITH\s+RECURSIVE/i);
    expect(code).toContain('AND NOT (callee.proname::text = ANY (v_seen));');
    expect(code).toContain('v_seen  := v_seen || v_frontier;');
    expect(code).toMatch(/IF EXISTS \(SELECT 1 FROM pg_proc p[\s\S]*?\) THEN\s+RETURN true;/);
    expect(code).toContain(
      'EXIT WHEN v_depth >= GREATEST(p_max_depth, 1) OR cardinality(v_frontier) = 0;'
    );
  });

  it('keeps the same edges and the same doors', () => {
    expect(code).toContain('AND length(callee.proname) > 6');
    expect(code).toContain("AND caller.prosrc LIKE '%' || callee.proname || '(%'");
    expect(code).toMatch(
      /p\.prosrc LIKE '%club_members%'\s+OR p\.prosrc LIKE '%fn_pay_player_chips%'/
    );
    expect(code).toContain("callee.pronamespace = 'public'::regnamespace");
    expect(code).toContain("caller.pronamespace = 'public'::regnamespace");
    expect(FN).toContain('STABLE SECURITY DEFINER');
  });
});
