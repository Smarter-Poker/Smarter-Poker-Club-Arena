/**
 * PAGE PREFERENCES COUNT THE ROW THEY WROTE, AND THE DEAD ARENA FREEZE SCOPE
 * IS RETIRED
 *
 * update_page_preferences ran its UPDATE through EXECUTE ... INTO and then
 * tested FOUND. PL/pgSQL: "EXECUTE changes the output of GET DIAGNOSTICS, but
 * does not change FOUND", and FOUND starts false in every call, so the function
 * raised 'Profile not found' on every call and rolled its own update back. No
 * profile ever saved a bankroll, news, memory-games or video-library
 * preference through it. Migration 20261004231057 replaces the test with the
 * EXECUTE's own row count and changes nothing else.
 *
 * The same file retires the 'arena_withdrawals' payout-freeze scope, whose one
 * reader (fn_arena_withdraw) is dropped by 20261004214251: an operator could
 * open a freeze in it and believe something had stopped.
 *
 * Proved on a local PostgreSQL 16 with the live definitions loaded (md5s equal
 * to production's): see docs/changelog/2026-10-04-page-preferences-count-the-
 * row-they-wrote.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
const SQL = readFileSync(
  resolve(DIR, '20261004231057_page_preferences_count_the_row_they_wrote_and_the_dead_arena.sql'),
  'utf8'
);
/** The statements, without the header and comment lines that describe the old defect. */
const CODE = SQL.split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

describe('update_page_preferences answers from the row count of its EXECUTE', () => {
  it('replaces the FOUND test with GET DIAGNOSTICS ROW_COUNT, by exact text', () => {
    expect(CODE).toContain(
      [
        '  ) INTO v_preferences USING p_preferences, p_user_id;',
        '  GET DIAGNOSTICS v_rows = ROW_COUNT;',
        '  IF v_rows = 0 THEN',
      ].join('\n')
    );
    expect(CODE).toContain(['  v_preferences jsonb;', '  v_rows bigint;', 'BEGIN'].join('\n'));
  });

  it('refuses a postimage that still tests FOUND, and keeps the caller check and the refusal', () => {
    expect(CODE).toContain("IF v_after ~ '\\mFOUND\\M'");
    expect(CODE).toContain(
      "position('IF auth.uid() IS NULL OR auth.uid() != p_user_id THEN' IN v_after) = 0"
    );
    expect(CODE).toContain("position('RAISE EXCEPTION ''Profile not found'';' IN v_after) = 0");
  });

  it('is written against the text 20261004214251 leaves, and pins its own postimage', () => {
    expect(CODE).toContain(
      "('public.update_page_preferences(uuid,text,jsonb)', '8cd27b35b801feb60a239bdf1c0c51cd')"
    );
    expect(CODE).toContain("IF md5(v_after) <> '875d8538e2edb229d6ebe898eebb1281' THEN");
    expect(SQL).toMatch(
      /^-- @live-proof: md5\(pg_get_functiondef\('public\.update_page_preferences\(uuid,text,jsonb\)'::regprocedure\)\) = '875d8538e2edb229d6ebe898eebb1281'$/m
    );
  });

  it('moves no grant and no owner, and never creates the function from a hand-written body', () => {
    expect(CODE).toContain('its grants or owner moved');
    expect(CODE).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
    expect(CODE).not.toMatch(/\b(GRANT|REVOKE)\b/);
    expect(CODE).toContain(
      "NOT has_function_privilege('authenticated', 'public.update_page_preferences(uuid,text,jsonb)', 'EXECUTE')"
    );
  });
});

describe("the 'arena_withdrawals' freeze scope is retired, and only that scope", () => {
  it('the opener stops accepting it', () => {
    expect(CODE).toContain(
      "$o3$                     'diamond_tournament_payouts', 'arena_withdrawals') THEN"
    );
    expect(CODE).toContain("$n3$                     'diamond_tournament_payouts') THEN");
    expect(CODE).toContain(
      "IF md5(v_after) <> '03fe1a6b3b13713de339f9a9c58eedef' OR position('arena_withdrawals' IN v_after) > 0 THEN"
    );
  });

  it('the constraint keeps the nine other scopes', () => {
    const add = CODE.slice(
      CODE.indexOf('ADD CONSTRAINT ca_payout_freeze_scope_check'),
      CODE.indexOf('COMMENT ON COLUMN public.ca_payout_freeze.scope')
    );
    const scopes = [...add.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
    expect(scopes).toEqual([
      'tournament_payouts',
      'bbj_payouts',
      'diamond_issuance',
      'diamond_tournament_payouts',
      'wheel',
      'plinko',
      'crash',
      'crossing',
      'mines',
    ]);
  });

  it('never deletes or rewrites a freeze row: it refuses if the scope holds one', () => {
    expect(CODE).not.toMatch(/\b(DELETE FROM|UPDATE|TRUNCATE)\s+(public\.)?ca_payout_freeze/);
    expect(CODE).toContain(
      "SELECT count(*) INTO v_n FROM public.ca_payout_freeze WHERE scope = 'arena_withdrawals';"
    );
    expect(
      CODE.indexOf('LOCK TABLE public.ca_payout_freeze IN ACCESS EXCLUSIVE MODE;')
    ).toBeLessThan(CODE.indexOf("WHERE scope = 'arena_withdrawals';"));
  });

  it('refuses while any other function still reads the scope', () => {
    expect(CODE).toContain('preimage: a function still names the arena_withdrawals scope');
  });

  it('takes its table lock in bounded 250 ms attempts, inside one transaction', () => {
    expect(CODE).toContain("PERFORM set_config('lock_timeout', '250ms', true);");
    expect(CODE).toContain('IF v_tries >= 40 THEN');
    expect(CODE.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(CODE.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(CODE).toMatch(/^SET LOCAL lock_timeout = '2s';$/m);
  });
});
