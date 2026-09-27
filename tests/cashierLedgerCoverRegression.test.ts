import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const dir = 'tests/fixtures/cashier-statements/';
const migrationPath =
  'supabase/migrations/20260927152809_cashier_movement_totals_use_a_covered_ledger_range.sql';
const migration = read(migrationPath);
const online = read(dir + 'ledger-cover-build-online.sql')
  .replace(/^--.*$/gm, '')
  .trim();
const native = read(dir + 'ledger-cover-native.py');

describe('Cashier ledger cover preserves the installed accounting reader', () => {
  it.each([
    migrationPath,
    ...[
      'ledger-cover-build-online.sql',
      'ledger-cover-recover-online.sql',
      'ledger-cover-native.py',
      'ledger-cover-boundaries.sql',
      'ledger-cover-installed-rows.sql',
    ].map((p) => dir + p),
  ])('runs required native accounting for %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });
  it('covers only bounded identity and numeric columns for the exact existing categories', () => {
    expect(online).toMatch(/^CREATE INDEX CONCURRENTLY idx_chip_ledger_cashier_totals_cover/);
    expect(online).toContain('INCLUDE (id, amount, from_entity_id, to_entity_id)');
    expect(online.match(/;/g)).toHaveLength(1);
    expect(online).not.toMatch(/metadata|idempotency_key|notes|label/);
    const rows = read(dir + 'ledger-cover-installed-rows.sql');
    expect(createHash('md5').update(rows).digest('hex')).toBe('49e310be00e91afc9a9b7582bb048184');
    const categories = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    const existing = rows.slice(rows.indexOf("ARRAY['buyin'"), rows.indexOf('::text[],  -- $17'));
    const covered = online.slice(online.indexOf('ARRAY['), online.indexOf(']::text[]'));
    expect(categories(covered)).toEqual(categories(existing));
    expect(migration).not.toMatch(
      /^\s*(?:ALTER TABLE|CREATE (?:OR REPLACE )?(?:FUNCTION|INDEX|POLICY|TRIGGER)|UPDATE |DELETE |GRANT |REVOKE )/m
    );
  });
  it('refuses source, permissions, column, owner and durable index drift without a build fallback', () => {
    for (const reason of [
      'SOURCE_CHANGED',
      'AUTHORITY_CHANGED',
      'COLUMN_CHANGED',
      'MISSING_BUILD_ONLINE',
      'INDEX_CHANGED',
    ])
      expect(migration).toContain('CASHIER_LEDGER_COVER_' + reason);
    expect(migration).toContain('i.indisvalid AND i.indisready AND i.indislive');
    expect(migration).toContain('numeric(15,2)');
    expect(migration).toContain('pg_get_indexdef(i.indexrelid)=$exact$');
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
  it('keeps real native behavior and snapshot recovery in the existing required lane', () => {
    expect(read('scripts/dev/test-cashier-statements.sh')).toContain(
      'python3 "$root/tests/fixtures/cashier-statements/ledger-cover-native.py"'
    );
    expect(read('.github/workflows/ci.yml')).toContain(
      'run: bash scripts/dev/test-cashier-statements.sh'
    );
    for (const proof of [
      'NOSUPERUSER BYPASSRLS',
      'totals_oracle(viewer,scope,f)',
      'matrix()==before',
      'waiting for old snapshots',
      "json.loads(durable())['valid'] is False",
      "q(migration,'CASHIER_LEDGER_COVER_INDEX_CHANGED')",
      'rebuild.wait(timeout=30)==0',
      'catalog()==original',
    ])
      expect(native).toContain(proof);
    expect(
      read(dir + 'ledger-cover-recover-online.sql')
        .replace(/^--.*$/gm, '')
        .trim()
    ).toBe('REINDEX INDEX CONCURRENTLY public.idx_chip_ledger_cashier_totals_cover;');
  });
});
