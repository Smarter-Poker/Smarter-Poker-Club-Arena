import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { splitConcurrentPreamble } from '../../scripts/ci/migration-concurrent-preamble.mjs';
const read = (path: string) => readFileSync(path, 'utf8');
const fixture = 'scripts/ci/fixtures/rake-record-bounded-cover/';
const manifest = JSON.parse(read(fixture + 'manifest.json'));
const files = manifest.migrations.map((p: string) => read(p));
describe('bounded tournament rake physical evidence', () => {
  it('retains the full actual authority and original source generation', () => {
    const authority = JSON.parse(read(fixture + 'authority.json'));
    expect([authority.columns.length, authority.constraints.length, authority.indexes.length,
      authority.triggers.length, authority.owners.length]).toEqual([20, 8, 19, 39, 34]);
    for (const sql of files) {
      expect(sql.split(read(fixture + 'guard.sql')).length).toBe(3);
      expect(sql).toContain('platform.max_index_columns<>32');
      expect(sql).toContain("original-inventory-245-v1:72b51e4349fc9cd371bfb7f771b7ae20");
      const executable = sql.replaceAll(read(fixture + 'guard.sql'), '');
      expect(executable).not.toMatch(/(?:UPDATE|DELETE FROM|INSERT INTO) public\./i);
      expect(executable).not.toContain('CREATE OR REPLACE FUNCTION public.');
    }
  });
  it('uses individually widened arithmetic and complementary predicates', () => {
    const predicate = read(fixture + 'predicate.sql').trim();
    expect((predicate.match(/::bigint/g) || []).length).toBe(11);
    expect(predicate).toContain('jsonb_send(returned_uncalled)');
    expect(predicate).not.toContain('numeric_send(returned_uncalled)');
    expect(files[1]).toContain('WHERE is_tournament AND ' + predicate);
    expect(files[2]).toContain('WHERE is_tournament AND NOT ' + predicate);
    expect(files[0]).toContain(read(fixture + 'helper.sql'));
    expect(files[0]).toContain(read(fixture + 'helper-guard.sql'));
  });
  it('keeps one recoverable CCI per independent protected install', () => {
    expect(splitConcurrentPreamble(files[0]).indexes).toHaveLength(0);
    for (const sql of files.slice(1)) {
      const parts = splitConcurrentPreamble(sql);
      expect(parts.ok).toBe(true);
      expect(parts.indexes).toHaveLength(1);
      expect(parts.body).toContain('bounded_rr_exact_index_structure_required');
      expect(parts.body).toContain('pg_get_indexdef');
      expect(parts.body).toContain('bounded_rr_exact_size_helper_required');
      expect(parts.body).toContain("version='20261029180415'");
    }
  });
  it('runs the real private PG17 test in the required accounting job', () => {
    const floor = read('scripts/ci/test_launch_reset_floor.py');
    expect(floor).toContain("'test-rake-record-bounded-cover-postgres.py'");
    expect(floor).toContain("args.output.with_name('rake-record-bounded-cover.json')");
    expect(floor).toContain("'test-original-linked-cash-spgist-postgres.py'");
  });
});
