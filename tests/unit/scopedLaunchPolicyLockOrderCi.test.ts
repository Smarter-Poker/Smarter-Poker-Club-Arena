import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path));
const ci = parse(read('.github/workflows/ci.yml').toString());

describe('The scoped launch qualifies its provider policy lock dependency', () => {
  it.each([
    'scripts/ci/test_launch_reset_policy_lock_order.py',
    'scripts/ci/fixtures/launch-reset/provider-policy-hook/witness.mjs',
    'scripts/ci/fixtures/launch-reset/provider-policy-hook/source-pins.json',
  ])('selects required accounting and source checks for %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('runs the actual hook against the same candidate once in the required reset job', () => {
    const steps = ci.jobs.accounting_postgres.steps.filter((step: { run?: string }) =>
      step.run?.includes('scripts/ci/test_launch_reset_policy_lock_order.py')
    );
    expect(steps).toHaveLength(1);
    const step = steps[0];
    expect(step.id).toBe('scoped_launch_reset');
    expect(step.if).toBe('matrix.shard == 1');
    expect(step['continue-on-error']).toBeUndefined();
    expect(step.run).toContain('--candidate "$launch_candidate"');
    expect(step.run).toContain('--pg-module node_modules/pg/lib/index.js');
    expect(step.run).toContain('--output "$PROBE_EVIDENCE/provider-policy-lock-order.json"');
    expect(step.run).toContain(
      'scripts/ci/test_launch_reset_balance.py --candidate-migration "$launch_candidate"'
    );
    expect(step.run).toContain('set -euo pipefail');
  });

  it('pins the actual official pre-fix source and concurrent witness', () => {
    const base = 'scripts/ci/fixtures/launch-reset/provider-policy-hook/';
    const pins = JSON.parse(read(base + 'source-pins.json').toString());
    expect(pins.commit).toBe('acdb8513f0fd1b96d0f17c686efb6bdfc53cea81');
    for (const [path, digest] of Object.entries(pins.files)) {
      expect(
        createHash('sha256')
          .update(read(base + path))
          .digest('hex')
      ).toBe(digest);
    }
  });
});
