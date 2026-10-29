import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const base = 'scripts/ci/fixtures/launch-reset/maintenance-write-admission/';
const migration =
  'supabase/migrations/20261029172107_maintenance_writers_reserve_retention_before_their_existing_.sql';

describe('maintenance admission stays in the existing required installer qualification', () => {
  it.each(
    ['qualify.py', 'preimages.json', 'postimages.json']
      .map((path) => base + path)
      .concat(migration, 'scripts/ci/test_launch_reset_installer.py')
  )('selects required accounting for %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('runs one checked finite child through the existing shard-one installer step', () => {
    const driver = read('scripts/ci/test_launch_reset_installer.py');
    expect(driver.match(/maintenance-write-admission\/qualify\.py/g)).toHaveLength(1);
    const child = driver.slice(driver.indexOf('maintenance-write-admission/qualify.py'));
    expect(child).toMatch(/check=True,\s*timeout=120/);
    expect(child).toContain(migration);
    expect(child).toContain("a.output.with_name('maintenance-write-admission.json')");
    expect(driver.indexOf('maintenance-write-admission/qualify.py')).toBeGreaterThan(
      driver.indexOf('maintenance-thaw-repair/qualify.py')
    );
    const workflow = parse(read('.github/workflows/ci.yml'));
    const steps = workflow.jobs.accounting_postgres.steps.filter((step: { run?: string }) =>
      step.run?.includes('scripts/ci/test_launch_reset_installer.py')
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBe('matrix.shard == 1');
    expect(steps[0]['continue-on-error']).toBeUndefined();
    expect(steps[0].run).toContain('set -euo pipefail');
  });

  it('declares the private helper without exposing a new public RPC', () => {
    const manifest = JSON.parse(
      read('scripts/ci/schema-manifest.d/maintenance-write-admission.json')
    );
    expect(manifest.functions).toEqual(['smarter_private.maintenance_write_admission']);
  });
});
