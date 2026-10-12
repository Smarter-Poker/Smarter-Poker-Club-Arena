import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/20261002231724_post_reset_cleanup_accepts_atomic_board_absence.sql'
  ),
  'utf8'
);

describe('post-reset certification atomic board admission', () => {
  it('admits only absent or complete board generations', () => {
    expect(migration).toContain('cardinality(v_board_tournaments) NOT IN(0,12)');
    expect(migration).toContain(
      'v_expected_count IS DISTINCT FROM cardinality(v_board_tournaments)'
    );
    expect(migration).toContain(
      "v_old constant text :=\n    'IF cardinality(v_board_tournaments)<>12 OR v_expected_count<>12'"
    );
    expect(migration).toContain('v_old_hits=1 AND v_new_hits=0');
    expect(migration).toContain('v_old_hits=0 AND v_new_hits=1');
    expect(migration).toContain('POST_RESET_ATOMIC_BOARD_SOURCE_DIGEST_REFUSED');
    expect(migration).toContain('POST_RESET_ATOMIC_BOARD_PREIMAGE_REFUSED');
  });

  it('preserves receipt closure and the private catalog contract', () => {
    expect(migration).toContain('v_receipt_tournaments IS DISTINCT FROM v_tournaments');
    expect(migration).toContain('POST_RESET_CERTIFICATION_TOURNAMENT_GRAPH_REFUSED');
    expect(migration).toContain('POST_RESET_ATOMIC_BOARD_POSTIMAGE_REFUSED');
    expect(migration).toContain('p.prosecdef');
    expect(migration).toContain("r.rolname='postgres'");
    expect(migration).toContain('NOT p.proleakproof');
    expect(migration).toContain("p.proparallel='u'");
    expect(migration).toContain(
      "p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']"
    );
    expect(migration).toContain(
      "LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner)))"
    );
    expect(migration).toContain("has_function_privilege('anon',v_proc,'EXECUTE')");
    expect(migration).toContain("has_function_privilege('authenticated',v_proc,'EXECUTE')");
    expect(migration).toContain("has_function_privilege('service_role',v_proc,'EXECUTE')");
  });

  it('is replay-safe, digest-bound and transactional', () => {
    expect(migration).toContain(
      "v_preimage_md5 constant text := 'f3e2ae948cbf344220873311a7cc10aa'"
    );
    expect(migration).toContain(
      "v_postimage_md5 constant text := 'd784a67061328a136e0ec6da61c1973e'"
    );
    expect(migration).toMatch(/^-- @live-proof:/m);
    expect(migration).toContain("SET LOCAL lock_timeout = '15s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '120s'");
    expect(migration.trim()).toMatch(/COMMIT;$/);
  });
});
