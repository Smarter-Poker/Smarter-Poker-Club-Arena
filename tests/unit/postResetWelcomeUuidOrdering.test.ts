import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/20261002223819_post_reset_cleanup_orders_uuid_values.sql'
  ),
  'utf8'
);

describe('post-reset certification UUID ordering', () => {
  it('replaces the unsupported UUID aggregate with one deterministic UUID', () => {
    expect(migration).toContain("v_old constant text := 'SELECT min(reset_operation_id),'");
    expect(migration).toContain(
      "'SELECT (array_agg(reset_operation_id ORDER BY reset_operation_id))[1],'"
    );
    expect(migration).toContain('v_old_hits=1 AND v_new_hits=0');
    expect(migration).toContain('v_old_hits=0 AND v_new_hits=1');
    expect(migration).toContain(
      "v_preimage_md5 constant text := '256fe1643b1043b83bb6e9372b3aefa0'"
    );
    expect(migration).toContain(
      "v_postimage_md5 constant text := 'f3e2ae948cbf344220873311a7cc10aa'"
    );
    expect(migration).toContain('POST_RESET_UUID_ORDER_SOURCE_DIGEST_REFUSED');
    expect(migration).toContain('POST_RESET_UUID_ORDER_PREIMAGE_REFUSED');
  });

  it('proves the private security and lineage guards survived the rewrite', () => {
    expect(migration).toContain('POST_RESET_UUID_ORDER_POSTIMAGE_REFUSED');
    expect(migration).toContain('p.prosecdef');
    expect(migration).toContain("r.rolname='postgres'");
    expect(migration).toContain("has_function_privilege('anon',v_proc,'EXECUTE')");
    expect(migration).toContain("has_function_privilege('authenticated',v_proc,'EXECUTE')");
    expect(migration).toContain("has_function_privilege('service_role',v_proc,'EXECUTE')");
    expect(migration).toContain(
      "p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']"
    );
    expect(migration).toContain(
      "p.prolang=(SELECT l.oid FROM pg_language l WHERE l.lanname='plpgsql')"
    );
    expect(migration).toContain("p.prorettype='pg_catalog.jsonb'::regtype");
    expect(migration).toContain(
      "LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner)))"
    );
    expect(migration).toContain('a.grantee<>p.proowner');
    expect(migration).toContain('reset_operation_id IS DISTINCT FROM v_operation');
    expect(migration).toContain('POST_RESET_CERTIFICATION_PACKAGE_LINEAGE_REFUSED');
  });

  it('is transactional and exposes a live source proof', () => {
    expect(migration).toMatch(/^-- @live-proof:/m);
    expect(migration).toContain("SET LOCAL lock_timeout = '15s'");
    expect(migration).toContain("SET LOCAL statement_timeout = '120s'");
    expect(migration.trim()).toMatch(/COMMIT;$/);
  });
});
