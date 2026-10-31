import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { splitConcurrentPreamble } from '../scripts/ci/migration-concurrent-preamble.mjs';
import { declaredFunctions } from '../scripts/ci/check-definer-authorization.mjs';
const read = (p: string) => readFileSync(p, 'utf8');
const fixture = 'scripts/ci/fixtures/original-shaped-cash-statistics/';
const migration = read(
  'supabase/migrations/20261029084451_original_shaped_cash_collects_its_boolean_index_statistics.sql'
);
describe('original shaped cash collects its index statistics', () => {
  it('collects real expression statistics with one bounded full table ANALYZE', () => {
    const split = splitConcurrentPreamble(migration);
    expect(split.ok).toBe(true);
    expect(split.indexes).toHaveLength(0);
    expect(declaredFunctions(migration)).toHaveLength(0);
    expect(migration.match(/ANALYZE public\.union_pnl_cash_outcomes;/g)).toHaveLength(1);
    expect(migration).not.toMatch(/ANALYZE public\.union_pnl_cash_outcomes\s*\(/);
    expect(migration).not.toMatch(
      /^\s*(?:CREATE\s+INDEX|ALTER\s+TABLE|UPDATE\s+public\.|DELETE\s+FROM|SET\s+plan_cache_mode|SET\s+STATISTICS)/im
    );
    expect(migration).toContain("SET LOCAL statement_timeout='15s'");
    expect(migration).toContain("SET LOCAL transaction_timeout='60s'");
    expect(migration).toContain("SET LOCAL lock_timeout='1s'");
    expect(migration).toContain("pg_catalog.sha256(pg_catalog.convert_to(statements[1],'UTF8'))");
    expect(migration).toContain('7b29ac92bc3f68052c70d66166d1a4177c6de0118bee7d081190255c6c8cf658');
    expect(migration).toContain("qualified->'schema_metadata'");
    expect(migration).toContain("qualified->'function_authorities'");
    expect(migration.match(/'metadata',to_jsonb\(p\)/g)).toHaveLength(2);
    expect(migration).toContain("qualified->'raw_triggers'");
    expect(migration).toContain('st.stadistinct=2');
    expect(migration).toContain('st.stanullfrac=0');
  });
  it('retains the installed index bytes and executes the causal/atomic native proof in Accounting1', () => {
    expect(
      createHash('sha256')
        .update(
          read(
            'supabase/migrations/20261029071236_original_shaped_cash_selects_the_stored_boolean_gate.sql'
          )
        )
        .digest('hex')
    ).toBe('7b29ac92bc3f68052c70d66166d1a4177c6de0118bee7d081190255c6c8cf658');
    const binding = JSON.parse(read(fixture + 'source-binding.json'));
    for (const [path, hash] of Object.entries(binding.source_sha256))
      expect(createHash('sha256').update(read(path)).digest('hex'), path).toBe(hash);
    expect(read('scripts/ci/test_launch_reset_floor.py')).toContain(
      "'test-original-shaped-cash-statistics-postgres.py'"
    );
    const runner = read('scripts/ci/test-original-shaped-cash-statistics-postgres.py');
    expect(runner).toContain('native_post_guard_failure');
    expect(runner).toContain('noncritical26_owner_body_drift_after_snapshot');
    expect(runner).toContain('causal_inverse_same_table_statistics');
    expect(runner).toContain('generic_index_choice_not_forced_or_guaranteed');
  });
});
