import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitConcurrentPreamble } from '../scripts/ci/migration-concurrent-preamble.mjs';
import { declaredFunctions } from '../scripts/ci/check-definer-authorization.mjs';
const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const fixture = 'scripts/ci/fixtures/tournament-membership-union-key/';
const migration = read(
  'supabase/migrations/20261029032041_tournament_membership_keeps_its_union_in_the_identity_key.sql'
);
describe('the original tournament membership keeps its Union predicate', () => {
  it('adds only the raw Union identity selector and preserves old producers and indexes', () => {
    const parts = splitConcurrentPreamble(migration);
    expect(parts.ok).toBe(true);
    expect(parts.indexes).toHaveLength(1);
    expect(parts.indexes[0].statement).toContain(
      "btree(row_id,union_id)WHERE source_name='tournaments'"
    );
    expect(declaredFunctions(migration)).toHaveLength(0);
    expect(migration).not.toMatch(/DROP\s+INDEX|ALTER\s+TABLE|DELETE\s+FROM|UPDATE\s+public\./i);
    const contract = JSON.parse(read(fixture + 'meaningful-table-contract.json'));
    expect(contract.columns).toHaveLength(9);
    expect(contract.constraints).toHaveLength(2);
    expect(contract.indexes).toHaveLength(3);
    expect(contract.triggers).toHaveLength(1);
    for (const name of [
      'union_pnl_inventory_touches_pkey',
      'union_pnl_inventory_touches_week',
      'union_pnl_inventory_touches_identity',
    ]) {
      expect(
        contract.indexes.some((i: { definition: string }) => i.definition.includes(name))
      ).toBe(true);
    }
    expect(migration).toContain("qualified->'raw_triggers'");
    expect(migration).toContain("qualified->'function_authorities'");
    expect(migration).toContain('original-inventory-245-v1:72b51e4349fc9cd371bfb7f771b7ae20');
  });
  it('executes the byte-exact touched query from the unchanged original report', () => {
    const report = read(fixture + 'original-report.sql');
    expect(createHash('md5').update(report).digest('hex')).toBe('f4664dbbf53c790d967680a51a4d7cd6');
    const start = report.indexOf('WITH touched AS MATERIALIZED (');
    const end = report.indexOf('IF v_bad=0 THEN', start);
    expect(start).toBeGreaterThan(-1);
    expect(read(fixture + 'original-touched-query.sql').trim()).toBe(
      report.slice(start, end).trim()
    );
    expect(migration).not.toContain('SET plan_cache_mode');
    expect(migration).not.toContain('ANALYZE ');
  });
  it('runs genuine native index/refusal/append boundaries in the existing accounting gate', () => {
    expect(read('scripts/ci/test_launch_reset_floor.py')).toContain(
      "'test-tournament-membership-union-key-postgres.py'"
    );
    const runner = read('scripts/ci/test-tournament-membership-union-key-postgres.py');
    expect(runner).toContain("await_phase('waiting for old snapshots')");
    expect(runner).toContain("await_phase('waiting for writers before build')");
    expect(runner).toContain('production_capacity_claimed');
  });
});
