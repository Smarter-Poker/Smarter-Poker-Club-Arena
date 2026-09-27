import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';
const root = resolve(import.meta.dirname, '..');
describe('BBJ contribution covering index qualification', () => {
  it.each([
    'scripts/ci/test-bbj-contribution-cover-postgres.py',
    'scripts/ci/fixtures/bbj-contribution-cover/bootstrap.sql',
    'scripts/ci/fixtures/bbj-contribution-cover/fn_bbj_pool_facts.sql',
    'scripts/ci/fixtures/bbj-contribution-cover/fn_bbj_promo_facts.sql',
    'scripts/ops/build-bbj-contribution-cover-concurrently.sql',
    'tests/bbjContributionCoverRegression.test.ts',
  ])('runs native accounting for every changed input: %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });
  it('executes the actual isolated native proof without a skipped failure', () => {
    const workflow = parse(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'));
    const steps = workflow.jobs.accounting_postgres.steps.filter((s: { run?: string }) =>
      s.run?.includes('python3 scripts/ci/test-bbj-contribution-cover-postgres.py')
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBe('matrix.shard == 4');
    expect(steps[0]['continue-on-error']).toBeUndefined();
  });
});
