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
