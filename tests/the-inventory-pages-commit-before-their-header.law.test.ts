import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');
const migration = read(
  'supabase/migrations/20261012200734_inventory_seal_pages_commit_before_their_immutable_header.sql'
);
const runner = read('scripts/dev/test-inventory-seal-committed-pages.py');
const ci = read('.github/workflows/ci.yml');

describe('inventory pages commit before their immutable header', () => {
  it('preserves the installed history and original deferred constraints', () => {
    for (const pin of [
      '47b1a3a80eec9fc6a593e99ebef27c27',
      '787b8eef33e7e290deb48677b8a82d51',
      '6f12d08d5c4f68c93a05b59b4adad8c2',
    ])
      expect(migration).toContain(pin);
    expect(migration).toContain('condeferrable AND condeferred');
    expect(migration).toContain('inventory_original_writer_owns_installation_boundary');
    expect(migration).toContain('inventory_installation_requires_thawed_platform');
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.trim().endsWith('COMMIT;')).toBe(true);
  });

  it('retains private logged pages and publishes only the verified completed set', () => {
    expect(migration).toContain('CREATE TABLE public.union_pnl_inventory_seal_build_rows');
    expect(migration).toContain(
      'JOIN public.union_pnl_inventory_seal_builds b ON b.boundary=r.boundary AND b.ready'
    );
    expect(migration).toContain('inventory_build_checksum_disagrees_with_original_source');
    expect(migration).not.toMatch(/(?:ALTER|DROP) TABLE public\.union_pnl_inventory_checkpoints/);
    expect(migration).not.toContain(
      'CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_population'
    );
  });

  it('executes the actual deferred-FK counterexample and committed consumer proof in required CI', () => {
    const start = ci.indexOf(
      '- name: Inventory pages commit before their immutable checkpoint header'
    );
    const end = ci.indexOf('- name: Tournament blinds publish atomically across the field', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const step = ci.slice(start, end);
    expect(step).toContain('if: matrix.shard == 3');
    expect(step).toContain('python3 scripts/dev/test-inventory-seal-committed-pages.py');
    expect(step).toContain('actions/upload-artifact@v4');
    expect(step).toContain('if-no-files-found: error');
    for (const pin of [
      'seed(430000)',
      "'foreign key constraint'",
      'private_receipt',
      'expected==actual',
      'PgSleep',
      'inventory_original_deferred_header_constraints_required',
    ])
      expect(runner).toContain(pin);
    expect(read('tests/fixtures/inventory-seal-committed-pages/bootstrap.sql')).toContain(
      'DEFERRABLE INITIALLY DEFERRED'
    );
  });
});
