import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { expect, it } from 'vitest';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

it('runs the native own-history regression in the required PostgreSQL accounting job', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const jobs = Object.entries(workflow.jobs) as [string, { steps?: Record<string, unknown>[] }][];
  const owning = jobs.find(([, job]) =>
    job.steps?.some((step) =>
      String(step.run).includes('python3 -B scripts/ci/test-diamond-own-history-postgres.py')
    )
  );
  expect(owning?.[0]).toMatch(/accounting/);
  const step = owning![1].steps!.find((item) =>
    String(item.run).includes('python3 -B scripts/ci/test-diamond-own-history-postgres.py')
  )!;
  expect(step.if).toBe('matrix.shard == 3');
  expect(step['continue-on-error']).toBeUndefined();
  expect(step.env).toEqual({ PG_BIN: '/usr/lib/postgresql/17/bin' });
  const classification = classifyChangedPaths(['scripts/ci/test-diamond-own-history-postgres.py']);
  expect(classification).toMatchObject({ server: true });
});
