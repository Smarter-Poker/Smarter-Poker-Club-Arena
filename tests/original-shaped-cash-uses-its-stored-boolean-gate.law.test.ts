import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { splitConcurrentPreamble } from '../scripts/ci/migration-concurrent-preamble.mjs';
import { declaredFunctions } from '../scripts/ci/check-definer-authorization.mjs';
const read = (p: string) => readFileSync(p, 'utf8');
const fixture = 'scripts/ci/fixtures/original-shaped-cash-boolgate/';
const migration = read(
  'supabase/migrations/20261029071236_original_shaped_cash_selects_the_stored_boolean_gate.sql'
);
describe('original shaped cash uses its stored Boolean gate', () => {
  it('adds one fixed width physical selector without changing original producers or row admission', () => {
    const split = splitConcurrentPreamble(migration);
    expect(split.ok).toBe(true);
    expect(split.indexes).toHaveLength(1);
    expect(split.indexes[0].statement).toContain('recognized_at)INCLUDE(table_id,hand_number)');
    expect(split.indexes[0].statement).toContain("evidence->>'status' IS DISTINCT FROM 'ready'");
    expect(split.indexes[0].statement).toContain(
      "evidence->'game_scope' IS DISTINCT FROM game_scope"
    );
    expect(declaredFunctions(migration)).toHaveLength(0);
    expect(migration).not.toMatch(
      /DROP\s+INDEX|ALTER\s+TABLE|UPDATE\s+public\.|DELETE\s+FROM|SET\s+plan_cache_mode|ANALYZE\s/i
    );
    const table = JSON.parse(read(fixture + 'meaningful-table-contract.json'));
    expect(table.columns).toHaveLength(8);
    expect(table.constraints).toHaveLength(3);
    expect(table.indexes).toHaveLength(7);
    expect(table.triggers).toHaveLength(4);
    expect(migration).toContain("qualified->'raw_triggers'");
    expect(migration).toContain("qualified->'function_authorities'");
    expect(
      createHash('md5')
        .update(read(fixture + 'original-shaped-hands.sql'))
        .digest('hex')
    ).toBe('78b5d525a31a79ff1b13a5cfe0ddf739');
  });
  it('binds all qualification inputs and runs native boundaries in required Accounting1', () => {
    const binding = JSON.parse(read(fixture + 'source-binding.json'));
    for (const [path, hash] of Object.entries(binding.source_sha256)) {
      expect(createHash('sha256').update(read(path)).digest('hex'), path).toBe(hash);
    }
    expect(read('scripts/ci/test_launch_reset_floor.py')).toContain(
      "'test-original-shaped-cash-boolgate-postgres.py'"
    );
    const runner = read('scripts/ci/test-original-shaped-cash-boolgate-postgres.py');
    expect(runner).toContain("await_phase('waiting for old snapshots')");
    expect(runner).toContain("await_phase('waiting for writers before build')");
    expect(runner).toContain('correlated_bitmap_predicate_recheck_allowed_and_recorded');
    expect(runner).toContain('production_capacity_claimed');
  });
});
