import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

describe('interrupted contract index recovery reaches the required real database proof', () => {
  it.each([
    'scripts/ci/contract-index-recovery.mjs',
    'scripts/ci/contract-index-recovery.test.mjs',
    'scripts/ci/test-contract-index-recovery-postgres.py',
    'scripts/ci/apply-recorded-migration.mjs',
    '.github/workflows/apply-merged-migration.yml',
  ])('admits accounting and its controls for %s', (path) => {
    const flags = classifyChangedPaths([path]);
    expect(flags.server).toBe(true);
    expect(flags.tests).toBe(true);
  });
  it('executes the actual guard controls and native fixture in the existing required accounting job', () => {
    const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
    const step = ci.jobs.accounting_postgres.steps.find(
      (s: { id?: string }) => s.id === 'contract_index_recovery'
    );
    expect(step.if).toBe('matrix.shard == 4');
    expect(step.run).toContain('node --test scripts/ci/contract-index-recovery.test.mjs');
    expect(step.run).toContain('python3 -B scripts/ci/test-contract-index-recovery-postgres.py');
    expect(step['continue-on-error']).toBeUndefined();
  });
});
