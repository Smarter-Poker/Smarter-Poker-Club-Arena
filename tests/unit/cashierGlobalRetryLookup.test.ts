import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrationTransactionShape } from '../../scripts/ci/migration-transaction-shape.mjs';

const migration = '20261026224428_cashier_global_retry_lookup_index.sql';
const sql = readFileSync(`supabase/migrations/${migration}`, 'utf8');

describe('global cashier retry lookup remains bounded and globally exact', () => {
  it('installs a concurrent nonunique operation index through the existing applier', () => {
    const shape = migrationTransactionShape(migration, sql);
    expect(shape.ok).toBe(true);
    if (!shape.ok) return;
    expect(shape.indexes).toHaveLength(1);
    expect(sql).toContain("ON public.chip_transactions USING btree ((metadata ->> 'op_id'))");
    expect(sql).toContain("WHERE (metadata ->> 'op_id') IS NOT NULL");
    expect(sql).toContain('i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique');
  });

  it('keeps the native planner and foreign duplicate cases in the required cashier lane', () => {
    const fixture = readFileSync(
      'scripts/ci/test-cashier-authority-exact-intent-postgres.py',
      'utf8'
    );
    expect(fixture).toContain(migration);
    expect(fixture).toContain('force_generic_plan');
    expect(fixture).toContain('global-op-legacy-foreign-duplicate-refused');
    expect(fixture).toContain('global-op-wrong-shape-refused');
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toContain(
      'run: python3 scripts/ci/test-cashier-authority-exact-intent-postgres.py --output artifacts/cashier-authority-recovery'
    );
  });
});
