import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const read = (path: string) => readFileSync(path, 'utf8');
const migration = read(
  'supabase/migrations/20260927003247_scoped_achievement_and_commission_history_reads.sql'
);
describe('scoped audit reads retain native authorization qualification', () => {
  it.each([
    'scripts/ci/test-scoped-audit-reads.py',
    'scripts/ci/fixtures/scoped-audit-reads/baseline.json',
    'tests/scopedAuditReadRegression.test.ts',
  ])('executes native checks for isolated input %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });
  it('uses the real isolated role fixture in the required database job', () => {
    const workflow = parse(read('.github/workflows/ci.yml'));
    const steps = workflow.jobs.accounting_postgres.steps.filter((step: { run?: string }) =>
      step.run?.includes('test-scoped-audit-reads.py')
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBe('matrix.shard == 4');
    expect(steps[0].run).toBe('python3 scripts/ci/test-scoped-audit-reads.py');
    const runner = read('scripts/ci/test-scoped-audit-reads.py');
    expect(runner).toContain("expected, 'authenticator'");
    expect(runner).toContain('MIGRATION.read_text()');
    expect(runner).toContain('preserved() == original');
  });
  it('pins both unchanged authority helpers and changes only SELECT policies', () => {
    const fixture = JSON.parse(read('scripts/ci/fixtures/scoped-audit-reads/baseline.json'));
    for (const fn of fixture.functions) {
      expect(migration).toContain(createHash('md5').update(fn.definition).digest('hex'));
    }
    expect(migration.match(/FOR SELECT TO authenticated/g)).toHaveLength(3);
    expect(migration).toContain('user_id = (SELECT auth.uid())');
    expect(migration).not.toMatch(
      /GRANT\s|CREATE\s+(?:OR REPLACE\s+)?FUNCTION|ALTER\s+PUBLICATION|INSERT\s+INTO|UPDATE\s+public\./i
    );
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
});
