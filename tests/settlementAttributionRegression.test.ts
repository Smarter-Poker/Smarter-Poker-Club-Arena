import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const read = (path: string) => readFileSync(path, 'utf8');
const migrations = readdirSync('supabase/migrations').filter((p) =>
  p.endsWith('_bound_settlement_attribution_scan_before_result_limit.sql')
);
describe('settlement attribution retains the complete financial predicate', () => {
  it.each([
    'scripts/ci/test-settlement-attribution-postgres.py',
    'scripts/ci/fixtures/settlement-attribution/baseline.sql',
    'scripts/ci/fixtures/settlement-attribution/qualify-first-attempt-index.py',
    'scripts/ci/fixtures/settlement-attribution/build-first-attempt-index.sql',
    'scripts/ci/fixtures/settlement-attribution/recover-first-attempt-index.sql',
    'scripts/ci/fixtures/settlement-attribution/first-attempt-preimage.json',
    'scripts/ci/fixtures/settlement-attribution/first-attempt-preflight.sql',
    'tests/settlementAttributionRegression.test.ts',
  ])('executes native accounting qualification for isolated input %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });
  it('runs the actual native fixture in the existing required database job', () => {
    const workflow = parse(read('.github/workflows/ci.yml'));
    const steps = workflow.jobs.accounting_postgres.steps.filter((s: { run?: string }) =>
      s.run?.includes('test-settlement-attribution-postgres.py')
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      if: 'matrix.shard == 4',
      run: 'python3 scripts/ci/test-settlement-attribution-postgres.py',
    });
  });
  it('changes only the placement of the existing limit around the exact aggregate', () => {
    expect(migrations).toHaveLength(1);
    const sql = read('supabase/migrations/' + migrations[0]);
    const baseline =
      read('scripts/ci/fixtures/settlement-attribution/baseline.sql').trimEnd() + '\n';
    expect(sql).toContain(createHash('md5').update(baseline).digest('hex'));
    const old = sql.match(/\$old\$([\s\S]*?)\$old\$/)![1];
    const next = sql.match(/\$new\$([\s\S]*?)\$new\$/)![1];
    expect(baseline.split(old)).toHaveLength(2);
    expect(next).toBe(
      '    WITH attributed AS MATERIALIZED (\n' +
        old
          .replace(/\n {4}LIMIT 20$/, '')
          .split('\n')
          .map((l) => '  ' + l)
          .join('\n') +
        '\n    )\n    SELECT * FROM attributed LIMIT 20'
    );
    expect(sql).not.toMatch(/CREATE INDEX|cron\.|GRANT\s|ALTER\s|is_horse/i);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).toContain("SET LOCAL lock_timeout='4s'");
    expect(sql).toContain('SETTLEMENT_ATTRIBUTION_SOURCE_CHANGED');
  });
});

describe('settlement attempt timestamp index preserves the financial caller', () => {
  it('binds the complete installed financial definition and online-only verification', () => {
    const names = readdirSync('supabase/migrations').filter((p) =>
      p.endsWith('_settlement_attempt_counts_use_their_original_time_boundary.sql')
    );
    expect(names).toHaveLength(1);
    const sql = read('supabase/migrations/' + names[0]);
    const captured = JSON.parse(
      read('scripts/ci/fixtures/settlement-attribution/first-attempt-preimage.json')
    );
    expect(createHash('md5').update(captured.function.definition).digest('hex')).toBe(
      'dbaa8f091599d0ecd9bdb2e56b85536f'
    );
    expect(sql).toContain(captured.function.md5);
    expect(sql).not.toMatch(
      /CREATE(?: OR REPLACE)? FUNCTION|CREATE INDEX|ALTER TABLE|GRANT\s|REVOKE\s|cron\.|PERFORM\s/i
    );
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    for (const guard of [
      'indisvalid',
      'indisready',
      'indislive',
      'indpred IS NULL',
      'indexprs IS NULL',
      'attnotnull',
    ])
      expect(sql).toContain(guard);
    const build = read('scripts/ci/fixtures/settlement-attribution/build-first-attempt-index.sql');
    expect(build).toContain('CREATE INDEX CONCURRENTLY idx_settlement_idem_first_attempt');
    expect(build).toContain('USING btree (first_attempt_at)');
    expect(build).not.toMatch(/^BEGIN;|IF NOT EXISTS|WHERE|INCLUDE/m);
    const recovery = read(
      'scripts/ci/fixtures/settlement-attribution/recover-first-attempt-index.sql'
    );
    expect(recovery).toContain(
      'REINDEX INDEX CONCURRENTLY public.idx_settlement_idem_first_attempt;'
    );
    expect(recovery).not.toMatch(/DROP INDEX|CREATE INDEX|^BEGIN;/m);
  });
  it('executes the additional real-role concurrent index fixture by default', () => {
    const runner = read('scripts/ci/test-settlement-attribution-postgres.py');
    expect(runner).toContain('qualify-first-attempt-index.py');
    expect(runner).toContain('check=True, env=env, timeout=120');
    const fixture = read(
      'scripts/ci/fixtures/settlement-attribution/qualify-first-attempt-index.py'
    );
    expect(fixture).toContain('NOSUPERUSER BYPASSRLS');
    expect(fixture).toContain('waiting for old snapshots');
    expect(fixture).toContain('SETTLEMENT_ATTEMPT_INDEX_CONTRACT_CHANGED');
    expect(fixture).toContain('assert catalog()==before');
  });
});

describe('atomic coverage counts the exact all-player receipt population', () => {
  const fixture = 'scripts/ci/fixtures/settlement-attribution/';
  it.each([
    'qualify-coverage-history-index.py',
    'qualify-atomic-coverage.py',
    'qualify-coverage-receipt-index.py',
    'qualify-receipt-visibility.py',
    'coverage-receipt-preflight.sql',
    'build-coverage-receipt-index.sql',
    'recover-coverage-receipt-index.sql',
    'coverage-read.sql',
    'coverage-core-preimage.sql',
    'coverage-history-preflight.sql',
    'build-coverage-history-index.sql',
    'recover-coverage-history-index.sql',
  ])('requires native qualification for isolated input %s', (file) => {
    expect(classifyChangedPaths([fixture + file])).toMatchObject({ server: true, tests: true });
  });
  it('replaces only G while preserving every other financial detector byte', () => {
    const names = readdirSync('supabase/migrations').filter((p) =>
      p.endsWith('_settlement_coverage_counts_every_matching_atomic_hand.sql')
    );
    expect(names).toHaveLength(1);
    const sql = read('supabase/migrations/' + names[0]);
    const before = read(fixture + 'coverage-audit-before.sql');
    const after = read(fixture + 'coverage-audit-after.sql');
    const old = sql.match(/\$old\$([\s\S]*?)\$old\$/)![1];
    const next = sql.match(/\$new\$([\s\S]*?)\$new\$/)![1];
    expect(before.split(old)).toHaveLength(2);
    expect(after).toBe(before.replace(old, next));
    expect(createHash('md5').update(before).digest('hex')).toBe('dbaa8f091599d0ecd9bdb2e56b85536f');
    expect(sql).toContain(createHash('md5').update(after).digest('hex'));
    expect(next).not.toMatch(/has_human|is_horse|settlement_idempotency_keys/);
    for (const clause of [
      'c.hand_id=h.id',
      'c.table_id=h.table_id',
      'c.hand_number=h.hand_number',
      'v_hands_24h > 100',
      'v_claims_24h >= v_hands_24h / 2',
      'v_hands_1h >= 20',
      'v_claims_1h < (v_hands_1h * 9) / 10',
    ])
      expect(next).toContain(clause);
    expect(sql).toContain('indimmediate');
    expect(sql).toContain('ATOMIC_RECEIPT_INDEX_CONTRACT_CHANGED');
    expect(sql).toContain('SETTLEMENT_COVERAGE_AUTHORITY_PREIMAGE_CHANGED');
    expect(sql).toContain('SETTLEMENT_COVERAGE_PRODUCER_OR_RETENTION_CHANGED');
    expect(sql).not.toMatch(/CREATE INDEX|GRANT\s|REVOKE\s|cron\./i);
  });
  it('qualifies the narrow history index online without changing retention or financial bodies', () => {
    const names = readdirSync('supabase/migrations').filter((p) =>
      p.endsWith('_settlement_coverage_reads_recent_hand_identities_without_heap_scan.sql')
    );
    expect(names).toHaveLength(1);
    const sql = read('supabase/migrations/' + names[0]);
    expect(sql).toContain('HAND_COVERAGE_INDEX_CONTRACT_CHANGED');
    expect(sql).toContain("ARRAY['created_at','id','table_id','hand_number']");
    expect(sql).toContain('f75b94afaf46ff91db120bc34e1dc2ae');
    expect(sql).not.toMatch(
      /CREATE(?: OR REPLACE)? FUNCTION|CREATE INDEX|ALTER TABLE|GRANT\s|REVOKE\s|cron\./i
    );
    const build = read(fixture + 'build-coverage-history-index.sql');
    expect(build).toContain('CREATE INDEX CONCURRENTLY idx_hand_history_time_identity');
    expect(build).toContain('USING btree (created_at) INCLUDE (id,table_id,hand_number)');
    expect(build).not.toMatch(/^BEGIN;|IF NOT EXISTS|WHERE/m);
    expect(read(fixture + 'recover-coverage-history-index.sql')).toContain(
      'REINDEX INDEX CONCURRENTLY public.idx_hand_history_time_identity;'
    );
  });
  it('changes only two receipt maintenance thresholds while preserving source and authority', () => {
    const names = readdirSync('supabase/migrations').filter((p) =>
      p.endsWith('_atomic_receipt_visibility_follows_the_original_hand_maintena.sql')
    );
    expect(names).toHaveLength(1);
    const sql = read('supabase/migrations/' + names[0]);
    expect(sql).toContain('autovacuum_vacuum_threshold=20000');
    expect(sql).toContain('autovacuum_vacuum_insert_threshold=10000');
    expect(sql).toContain('ATOMIC_RECEIPT_MAINTENANCE_OPTIONS_CHANGED');
    expect(sql).toContain('ATOMIC_RECEIPT_MAINTENANCE_SOURCE_CHANGED');
    expect(sql).toContain('ATOMIC_RECEIPT_MAINTENANCE_CATALOG_CHANGED');
    expect(sql.match(/ALTER TABLE/g)).toHaveLength(1);
    expect(sql).not.toMatch(
      /CREATE(?: OR REPLACE)? FUNCTION|DELETE FROM|UPDATE public|INSERT INTO|GRANT\s|REVOKE\s|cron\.|VACUUM\s*\(/i
    );
    const native = read(fixture + 'qualify-receipt-visibility.py');
    for (const assertion of [
      'NOSUPERUSER BYPASSRLS',
      'REPEATABLE READ',
      'automaticVacuumObserved',
      'snapshotAndWriterRowsPreserved',
      'financialBodiesExecuted',
    ])
      expect(native).toContain(assertion);
  });
  it('executes every finite native qualification through the existing runner', () => {
    const runner = read('scripts/ci/test-settlement-attribution-postgres.py');
    expect(runner).toContain('qualify-coverage-history-index.py');
    expect(runner).toContain('qualify-atomic-coverage.py');
    expect(runner).toContain('qualify-coverage-receipt-index.py');
    expect(runner).toContain('qualify-receipt-visibility.py');
    expect(runner).toContain('check=True, env=env, timeout=120');
    const native = read(fixture + 'qualify-atomic-coverage.py');
    expect(native).toContain('NOSUPERUSER BYPASSRLS');
    expect(native).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(native).toContain('REPEATABLE READ');
    expect(native).toContain('otherFinancialBodiesExecuted');
  });
});
