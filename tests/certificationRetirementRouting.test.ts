import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

describe('certification identity retention qualification', () => {
  it.each([
    'scripts/ci/production-e2e-account.mjs',
    'scripts/ci/test-certification-retirement-postgres.py',
    'scripts/ci/fixtures/certification-retirement/setup.sql',
    'scripts/ci/fixtures/certification-retirement/baseline.json',
    'tests/unit/productionE2EAccount.test.ts',
  ])('runs native and unit qualification when %s changes', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });
  it('executes the real native fixture exactly once in the required accounting job', () => {
    const workflow = parse(readFileSync(resolve('.github/workflows/ci.yml'), 'utf8'));
    const matches = workflow.jobs.accounting_postgres.steps.filter((step: { run?: string }) =>
      step.run?.includes('test-certification-retirement-postgres.py')
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].if).toBe('matrix.shard == 4');
    expect(matches[0]['continue-on-error']).toBeUndefined();
  });
});
