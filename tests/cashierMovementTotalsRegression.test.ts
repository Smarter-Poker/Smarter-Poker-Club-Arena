import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const fixture = 'tests/fixtures/cashier-statements/';
const migrationPath =
  'supabase/migrations/20260927150429_cashier_totals_match_receipt_omissions_before_the_movement_r.sql';
const migration = read(migrationPath);
const before = read(fixture + 'movement-totals-before.sql');
const after = read(fixture + 'movement-totals-after.sql');

describe('Cashier movement totals qualification', () => {
  it.each([
    migrationPath,
    fixture + 'movement-totals-native.py',
    fixture + 'movement-totals-before.sql',
    fixture + 'movement-totals-after.sql',
    fixture + 'movement-totals-boundaries.sql',
  ])('requires native accounting checks for %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('pins the installed predecessor and requires its original authority', () => {
    expect(createHash('md5').update(before).digest('hex')).toBe('d6152f4bb944489aa4e1dfaf5417fc00');
    expect(migration).toContain('CASHIER_TOTALS_SOURCE_CHANGED');
    expect(migration).toContain('CASHIER_TOTALS_AUTHORITY_CHANGED');
    expect(migration).toContain('CASHIER_TOTALS_NULL_CONTRACT_CHANGED');
    expect(migration).toContain('CASHIER_TOTALS_EXISTING_LOOKUP_INDEX_CHANGED');
    expect(migration).toContain('indisvalid AND indisready AND indislive');
    expect(migration).toContain('IF v_after IS DISTINCT FROM v_meta');
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('retains the entire page/export SQL and all original financial predicates', () => {
    const suffix = (sql: string) => sql.slice(sql.indexOf("    v_sql := E'WITH candidates AS"));
    expect(suffix(after)).toBe(suffix(before));
    const receipt = (sql: string) =>
      sql.slice(sql.indexOf('  v_receipt_base :='), sql.indexOf('  v_movement_base :='));
    expect(receipt(after)).toBe(receipt(before));
    expect(after).toContain('IF v_totals_only THEN');
    expect(after).toContain('WITH omitted_movements AS MATERIALIZED');
    expect(after).toContain("cl.category='refund' AND cl.to_type='player_wallet'");
    expect(after).toContain('cl.to_entity_id=restored.to_user_id AND cl.club_id=restored.club_id');
    expect(after).toContain("restored.created_at <= cl.created_at+interval '1 minute'");
    expect(after).not.toMatch(
      /CREATE INDEX|GRANT |REVOKE |statement_timeout|DELETE FROM|UPDATE public\./
    );
  });

  it('runs real role, full accounting oracle and snapshot qualification in the existing required lane', () => {
    const native = read(fixture + 'movement-totals-native.py');
    expect(read('scripts/dev/test-cashier-statements.sh')).toContain(
      'python3 "$root/tests/fixtures/cashier-statements/movement-totals-native.py"'
    );
    expect(read('.github/workflows/ci.yml')).toContain(
      'run: bash scripts/dev/test-cashier-statements.sh'
    );
    expect(native).toContain('NOSUPERUSER BYPASSRLS');
    expect(native).toContain('(FIXTURE/"regression.sql").read_text()');
    expect(native).toContain('totals_oracle(viewer,scope,f)');
    expect(native).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect(native).toContain('matrix()==before');
    expect(native).toContain('data_hash()==rows_hash');
    expect(native).toContain('user="authenticator"');
    expect(native).toContain("statement_timeout='8s'");
  });
});
