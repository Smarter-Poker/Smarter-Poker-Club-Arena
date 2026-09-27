import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const root = resolve(import.meta.dirname, '..');
describe('settlement conservation index qualification', () => {
  it.each([
    'scripts/ci/test-settlement-conservation-index-postgres.py',
    'scripts/ci/fixtures/settlement-conservation-index/bootstrap.sql',
    'scripts/ci/fixtures/settlement-conservation-index/installed.sql',
    'scripts/ops/build-settlement-conservation-index-concurrently.sql',
    'scripts/ops/recover-settlement-conservation-index-concurrently.sql',
    'tests/settlementConservationIndexRegression.test.ts',
  ])('enforces native and client qualification for %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });
  it('requires the full unchanged financial query fixture in the owning accounting shard', () => {
    const job = parse(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')).jobs
      .accounting_postgres;
    const steps = job.steps.filter((step: { run?: string }) =>
      step.run?.includes('python3 scripts/ci/test-settlement-conservation-index-postgres.py')
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBe('matrix.shard == 4');
    expect(steps[0]['continue-on-error']).toBeUndefined();
    expect(job['continue-on-error']).toBeUndefined();
  });
});
