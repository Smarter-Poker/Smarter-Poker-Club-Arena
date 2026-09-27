import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const migration = read(
  'supabase/migrations/20260926221856_cashier_receipt_totals_use_a_covered_club_time_range.sql'
);
const onlinePath = 'scripts/ops/build-cashier-totals-index-concurrently.sql';
const online = read(onlinePath)
  .replace(/^--.*$/gm, '')
  .trim();

describe('Cashier totals covered read qualification', () => {
  it.each([
    onlinePath,
    'tests/fixtures/cashier-statements/totals-index-native.py',
    'tests/fixtures/cashier-statements/ddl-guard-capture.json',
  ])('retains native accounting checks for isolated changes to %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });
  it('uses one online statement and no blocking fallback or accounting rewrite', () => {
    expect(online).toMatch(
      /^CREATE INDEX CONCURRENTLY idx_chip_tx_club_time_totals\s+ON public\.chip_transactions USING btree \(club_id, created_at DESC\)\s+INCLUDE \(amount, from_user_id, to_user_id\);$/
    );
    expect(migration).not.toMatch(
      /^CREATE\s+(?:OR REPLACE\s+)?(?:INDEX|FUNCTION|TRIGGER|POLICY)/im
    );
    expect(migration).toContain('CASHIER_TOTALS_INDEX_MISSING_BUILD_ONLINE');
    expect(migration).toContain('CASHIER_TOTALS_INDEX_CONTRACT_CHANGED');
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
  it('executes the maintained native oracle in the existing required accounting lane', () => {
    expect(read('.github/workflows/ci.yml')).toContain(
      'run: bash scripts/dev/test-cashier-statements.sh'
    );
    expect(read('scripts/dev/test-cashier-statements.sh')).toContain(
      'python3 "$root/tests/fixtures/cashier-statements/totals-index-native.py"'
    );
    const native = read('tests/fixtures/cashier-statements/totals-index-native.py');
    expect(native).toContain("FIXTURE / 'regression.sql'");
    expect(native).toContain('original_catalog = catalog()');
    expect(native).toContain('from maintenance_caller_native import qualify');
    expect(read('tests/fixtures/cashier-statements/maintenance_caller_native.py')).toContain(
      "fixture / 'ddl-guard-capture.json'"
    );
    expect(native).toContain("q(migration, 'CASHIER_TOTALS_INDEX_CONTRACT_CHANGED')");
  });
});
