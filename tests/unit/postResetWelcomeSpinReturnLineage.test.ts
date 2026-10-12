import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/20261003001112_post_reset_cleanup_follows_the_real_spin_return_lineage.sql'
  ),
  'utf8'
);
const writer = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/20260902010000_return_inactive_spin_seed_principal.sql'
  ),
  'utf8'
);
const reserveIdentity = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/20261002201605_spin_deactivation_names_the_reserve_row.sql'
  ),
  'utf8'
);

describe('post-reset Spin return lineage', () => {
  it('matches the canonical two-decimal writer key and concrete reserve identity', () => {
    expect(writer).toContain(
      "format('spin-deactivation-seed-return:%s:%s', v_owner, v_seed_returned_total)"
    );
    expect(reserveIdentity).toContain(
      "v_new text := $new$(v_actor, 'spin_reserve', v_pool.id, 'spin_bonus_pools.balance',$new$"
    );
    expect(migration).toContain("||'':200.00'')<>1");
    expect(migration).toContain('ON s.id=l.from_entity_id WHERE s.club_id=p_club_id');
    expect(migration).toContain('POST_RESET_CERTIFICATION_SEED_RETURN_LINEAGE_REFUSED');
  });

  it('rewrites one exact source fragment and remains replay safe', () => {
    expect(migration).toContain("||'':200'')<>1");
    expect(migration).toContain('v_old_hits=1 AND v_new_hits=0');
    expect(migration).toContain('v_old_hits=0 AND v_new_hits=1');
    expect(migration).toContain('POST_RESET_SPIN_RETURN_SOURCE_DIGEST_REFUSED');
    expect(migration).toContain('POST_RESET_SPIN_RETURN_PREIMAGE_REFUSED');
    expect(migration).toContain(
      "v_preimage_md5 constant text := 'd784a67061328a136e0ec6da61c1973e'"
    );
    expect(migration).toContain(
      "v_postimage_md5 constant text := '8ea4b2b5f9a80c4b8abbc620bd989c19'"
    );
  });

  it('preserves the private service-only catalog contract', () => {
    expect(migration).toContain('POST_RESET_SPIN_RETURN_POSTIMAGE_REFUSED');
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
    expect(migration.trim()).toMatch(/COMMIT;$/);
  });
});
