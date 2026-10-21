import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

describe('club entry news native regression remains enforced', () => {
  it('selects native accounting for receipt test changes', () => {
    expect(classifyChangedPaths(['scripts/ci/test-club-entry-news-postgres.py'])).toMatchObject({
      server: true,
      tests: true,
    });
  });
  it('runs once in the required accounting shard without failure suppression', () => {
    const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
    const steps = ci.jobs.accounting_postgres.steps.filter((step: { run?: string }) =>
      step.run?.includes('scripts/ci/test-club-entry-news-postgres.py')
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBe('matrix.shard == 2');
    expect(steps[0]['continue-on-error']).toBeUndefined();
    expect(steps[0].env.PG_BIN).toBe('/usr/lib/postgresql/17/bin');
    expect(steps[0].env.TMPDIR).toBe('${{ runner.temp }}');
  });
});
