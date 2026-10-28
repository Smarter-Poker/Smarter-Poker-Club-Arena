import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

describe('superseded action retention progress remains enforced', () => {
  it.each([
    'scripts/ci/test-superseded-retention-progress.py',
    'tests/unit/supersededRetentionProgress.test.ts',
  ])('selects required accounting for input-only change %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('runs the real PostgreSQL proof once in required accounting shard three', () => {
    const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
    const steps = ci.jobs.accounting_postgres.steps.filter((step: { run?: string }) =>
      step.run?.includes('scripts/ci/test-superseded-retention-progress.py')
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBe('matrix.shard == 3');
    expect(steps[0]['continue-on-error']).toBeUndefined();
    expect(steps[0].run).toContain('--pg-bin "$POKER_AUDIT_PG_BIN"');
    expect(steps[0].run).toContain('--evidence artifacts/superseded-retention-progress');
    expect(ci.jobs.accounting_postgres.steps).toContainEqual(
      expect.objectContaining({
        uses: 'actions/upload-artifact@v4',
        with: expect.objectContaining({ path: 'artifacts/superseded-retention-progress/' }),
      })
    );
  });
});
