import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

const binding = JSON.parse(
  readFileSync('tests/fixtures/weekly-recompute-split/source-binding.json', 'utf8')
);
const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));

describe('exact weekly recompute qualification reaches required CI', () => {
  it.each(Object.keys(binding.repository_files))('binds and selects %s', (path) => {
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(
      binding.repository_files[path]
    );
    expect(classifyChangedPaths([path]).server).toBe(true);
  });
  it('executes the native proof without suppressing failure and retains its result', () => {
    const step = ci.jobs.accounting_postgres.steps.find(
      (item: { id?: string }) => item.id === 'weekly_recompute_split'
    );
    expect(step).toMatchObject({
      if: 'matrix.shard == 1',
      env: { PG_BIN: '/usr/lib/postgresql/17/bin' },
    });
    expect(step.run).toContain(
      'python3 -B scripts/dev/test-union-weekly-basis.py --split-recompute-only'
    );
    expect(step['continue-on-error']).toBeUndefined();
    const artifact = ci.jobs.accounting_postgres.steps.find(
      (item: { name?: string }) => item.name === 'Retain exact weekly recompute qualification'
    );
    expect(artifact.if).toContain('always()');
    expect(artifact.with['if-no-files-found']).toBe('error');
    expect(artifact.with.path).toContain('*.json');
  });
});
