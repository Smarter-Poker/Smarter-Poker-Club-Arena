/**
 * A BOUNTY REBUY NEVER BORROWS A HELD FINISHING PLACE (2026-10-24)
 *
 * A PKO / bounty / mystery-bounty rebuy settles the old head through the legacy
 * bounty claim, which stamps a TEMPORARY field position on the entry before
 * the money core clears it. It used the raw `status='playing'` count, which is
 * very often the place the latest real elimination already holds, so
 * trg_tournament_place_collision refused it and every retry of the purchase
 * rolled back until the 30 second decision window closed: 5,846 refused
 * rebuys in one day, and horse rebuys on bounty events fell to 2-7 percent.
 * Dan: 276 entries and 9 rebuys "LOOKS FAKE".
 *
 * This pins the installed fix: the temporary position steps down to a place
 * nobody else holds, with a fallback above the highest held place, and the
 * install refuses to patch a body it did not measure.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20261024072516_a_bounty_rebuy_never_borrows_a_held_finishing_place.sql'
  ),
  'utf8'
);
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('a bounty rebuy never borrows a held finishing place', () => {
  it('is one transaction', () => {
    expect(code.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(code.match(/^COMMIT;$/gm)?.length).toBe(1);
  });

  it('patches the exact temporary-position line of the bounty rebuy step', () => {
    expect(code).toContain(
      "'public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)'::regprocedure"
    );
    expect(code).toContain('SELECT GREATEST(2,count(*)::integer) INTO v_position');
    expect(code).toMatch(/temporary-position anchor is not present exactly once/);
    expect(code).toMatch(/md5\(v_src\) <> '9ff3e2ce1a8207df2830c1358da94c66'/);
  });

  it('steps the temporary position away from every place another entrant holds', () => {
    const replacement = code.slice(code.indexOf('v_new := $new$'));
    expect(replacement).toMatch(
      /WHILE v_position>2 AND EXISTS \(\s*SELECT 1 FROM public\.tournament_players tp\s*WHERE tp\.tournament_id=p_tournament_id\s*AND tp\.position=v_position\s*AND tp\.user_id<>p_user_id\) LOOP\s*v_position:=v_position-1;/
    );
    expect(replacement).toMatch(/COALESCE\(max\(tp\.position\),1\)\+1\) INTO v_position/);
  });

  it('keeps the step private, security definer and bounded', () => {
    expect(code).toContain(
      "p.proconfig = ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[]"
    );
    for (const role of ['service_role', 'authenticated', 'anon']) {
      expect(code).toContain(`NOT has_function_privilege('${role}', p.oid, 'EXECUTE')`);
    }
  });
});
