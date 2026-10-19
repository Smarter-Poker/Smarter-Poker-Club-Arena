/**
 * THE INVENTORY SEAL PROVES ITS BUILD BUCKET BY BUCKET (2026-10-19)
 *
 * The 4.52M-row original inventory of the week 2026-10-12..19 was written into
 * committed build pages by 15:00 UTC, and the publishing tick was then
 * cancelled at job 272's 240 s statement timeout twice (15:05, 15:10): one
 * EXCEPT ALL of the whole cache against the whole build, both ways, ran past
 * 290 s in a read-only replay. Pinned on 20261019151632:
 *   - each side is read once into per-bucket counts and hashes, and the two
 *     bucket sets must be identical;
 *   - the build's own row buckets give the rows hash, which must still equal
 *     the original assembly's head, with the same bucketing and row text;
 *   - the whole-set EXCEPT ALL is gone;
 *   - the native committed-pages qualification installs this successor in
 *     every scenario and refuses a cache that drifted after its rows were
 *     copied.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  'supabase/migrations/20261019151632_the_inventory_seal_proves_its_build_bucket_by_bucket.sql',
  'utf8'
);
const harness = readFileSync('scripts/dev/test-inventory-seal-committed-pages.py', 'utf8');
const body = sql.slice(
  sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_seal_write_page('),
  sql.indexOf('END $function$;')
);

describe('the inventory seal proves its build bucket by bucket', () => {
  it('is one guarded transaction replacing the exact installed page writer', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(1);
    expect(sql).toContain("<>'3f0335746bcca5df4b0b9b475b47f7a8'");
    expect(sql).toContain("<>'3b45b74a0019ac3e65d40208a670299e'");
    expect(sql).toContain(
      "pg_try_advisory_xact_lock(hashtextextended('union-pnl-inventory-checkpoint',0))"
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_union_pnl_inventory_seal_write_page(timestamptz,timestamptz) FROM PUBLIC, anon, authenticated, service_role;'
    );
    expect(sql.replace(/--[^\n]*/g, ' ')).not.toMatch(/\bGRANT\b/);
  });

  it('compares per-bucket counts and hashes of the cache and the build', () => {
    expect(body.replace(/--[^\n]*/g, ' ')).not.toContain('EXCEPT ALL');
    expect(body).toContain('CREATE TEMP TABLE _inv_build_buckets ON COMMIT DROP AS');
    expect(body).toContain('CREATE TEMP TABLE _inv_cache_buckets ON COMMIT DROP AS');
    expect(body).toContain(
      'WHERE x.k IS NULL OR c.k IS NULL OR x.n IS DISTINCT FROM c.n OR x.h IS DISTINCT FROM c.h'
    );
    expect(body).toContain(
      "IF v_diff>0 THEN RAISE EXCEPTION 'inventory_build_disagrees_with_assembled_source'"
    );
  });

  it('still proves the rows hash against the original assembly head', () => {
    expect(body).toContain(
      "concat_ws('|',source_name,row_id,latest_event_id,first_operation,COALESCE(after_row::text,'~'))"
    );
    expect(body).toContain(
      "INTO v_rows,v_max,v_rows_md5 FROM pg_temp._inv_build_buckets WHERE k='row';"
    );
    expect(body).toContain(
      "RAISE EXCEPTION 'inventory_build_checksum_disagrees_with_original_source'"
    );
    expect(body).toContain("RAISE EXCEPTION 'inventory_build_row_exceeds_bounded_page'");
    expect(body).toContain(
      'IF NOT v_build.ready THEN UPDATE public.union_pnl_inventory_seal_builds SET ready=true'
    );
  });

  it('the native qualification installs the successor and refuses a drifted cache', () => {
    expect(harness).toContain(
      "SUCCESSORS=[root/'supabase/migrations/20261019151632_the_inventory_seal_proves_its_build_bucket_by_bucket.sql']"
    );
    expect(harness.match(/install_candidate\(candidate\)/g)?.length).toBeGreaterThanOrEqual(8);
    expect(harness).toContain(
      "'inventory_build_disagrees_with_assembled_source' in refused.stderr"
    );
  });
});
