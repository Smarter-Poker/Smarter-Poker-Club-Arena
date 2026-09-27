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
