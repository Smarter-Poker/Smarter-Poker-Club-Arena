import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Club Create Certification run 37080553539 refused a residual fixture club with
 * POST_RESET_CERTIFICATION_SEED_RETURN_LINEAGE_REFUSED. Eight predicates stand in
 * that block; seven pass and one has never passed. The reversal leg exists and is
 * correct, but the preparer looked it up by
 * 'spin-deactivation-seed-return:<club>:200' while the writer builds the key from
 * a numeric, which renders '200.00'. Same class as the min(uuid) in the same
 * routine: a type's text form assumed instead of read.
 *
 * The predicate now says what it means - the key names this club, and the amount
 * inside it IS 200, compared as a number - so it cannot rot the next time the
 * writer's scale changes. These pins keep the literal from coming back and keep
 * the rewrite guarded, because three agents edited this routine on 2026-10-02 and
 * a blind CREATE OR REPLACE would discard whichever change landed last.
 */
const MIGRATION = '20261003001046_the_seed_return_lineage_matches_the_key_the_reversal_actuall.sql';
const source = readFileSync(resolve(__dirname, '../../supabase/migrations', MIGRATION), 'utf8');
const sql = source.slice(source.indexOf('\nBEGIN;'));

describe('the seed return lineage matches the key the reversal wrote', () => {
  it('compares the amount in the key as a number, not as a rendered string', () => {
    expect(sql).toContain("split_part(l.idempotency_key,'':'',3)::numeric=200");
    expect(sql).toContain(
      "'AND l.idempotency_key LIKE ''spin-deactivation-seed-return:''||p_club_id::text||'':%'''"
    );
  });

  it('leaves no hard-coded rendering of the amount in the installed predicate', () => {
    // The old shape appears once, as the substitution's search text, and nowhere
    // else in the SQL this migration installs.
    const occurrences = sql.split("||'':200''").length - 1;
    expect(occurrences).toBe(2); // v_old, and the postimage assertion that refuses it
    expect(sql).toContain("OR v_source LIKE '%||'':200''%'");
  });

  it('is a guarded rewrite that refuses a source it does not recognise', () => {
    expect(sql).toContain("v_preimage_md5 constant text := 'd784a67061328a136e0ec6da61c1973e'");
    expect(sql).toContain('v_before:=pg_get_functiondef(v_proc)');
    expect(sql).toContain('SEED_RETURN_KEY_SOURCE_DIGEST_REFUSED');
    expect(sql).toContain('SEED_RETURN_KEY_SUBSTITUTION_REFUSED');
    expect(sql).toContain('SEED_RETURN_KEY_PREIMAGE_REFUSED');
    expect(sql).toContain('SEED_RETURN_KEY_POSTIMAGE_REFUSED');
    // Idempotent: already-rewritten source is a no-op, not a failure.
    expect(sql).toContain('ELSIF NOT (v_old_hits=0 AND v_new_hits=1) THEN');
  });

  it('keeps every other admission the three earlier edits established', () => {
    for (const pin of [
      'POST_RESET_CERTIFICATION_SEED_RETURN_LINEAGE_REFUSED',
      'cardinality(v_board_tournaments) NOT IN(0,12)',
      '(array_agg(reset_operation_id ORDER BY reset_operation_id))[1]',
      'i.reset_operation_id IS DISTINCT FROM v_operation',
      'POST_RESET_CERTIFICATION_TABLE_DELETE_PERMIT_NOT_CONSUMED',
      "l.amount=200 AND l.category=''reversal''",
    ]) {
      expect(sql).toContain(pin);
    }
  });

  it('keeps the preparer private and stays one transaction with its proof', () => {
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'
    );
    expect(sql).toContain('FROM PUBLIC,anon,authenticated,service_role');
    expect(sql).toContain("has_function_privilege('service_role',v_proc,'EXECUTE')");
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(source).toMatch(/^-- @live-proof:/m);
  });
});
