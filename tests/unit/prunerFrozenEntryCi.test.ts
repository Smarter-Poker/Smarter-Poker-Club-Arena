import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';
const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path));
const base = 'scripts/ci/fixtures/launch-reset/pruner-frozen-entry/';
const migration =
  'supabase/migrations/20261013151435_hand_history_pruning_yields_before_maintenance_thaw.sql';

describe('Frozen pruner entry stays in its existing required installer qualification', () => {
  it.each(
    ['qualify.py', 'witness.mjs', 'fixture-pins.json'].map((path) => base + path).concat(migration)
  )('selects required accounting and source checks for %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });
  it('runs one checked bounded child after the original pruner lane proof', () => {
    const driver = read('scripts/ci/test_launch_reset_installer.py').toString();
    expect(driver.match(/pruner-frozen-entry\/qualify\.py/g)).toHaveLength(1);
    expect(driver).toContain(migration.split('/').pop());
    const newChild = driver.slice(driver.indexOf('pruner-frozen-entry/qualify.py'));
    expect(newChild).toMatch(/check=True,\s*timeout=120/);
    expect(newChild).toContain("a.output.with_name('pruner-frozen-entry.json')");
    expect(driver.indexOf('pruner-frozen-entry/qualify.py')).toBeGreaterThan(
      driver.indexOf('pruner-lane/qualify.py')
    );
  });
  it('pins the untouched preimage and actual concurrency witness without changing original fixtures', () => {
    const pins = JSON.parse(read(base + 'fixture-pins.json').toString());
    for (const [path, digest] of Object.entries(pins)) {
      expect(createHash('sha256').update(read(path)).digest('hex')).toBe(digest);
    }
    expect(
      createHash('md5')
        .update(read('scripts/ci/fixtures/launch-reset/pruner-lane/expected.sql'))
        .digest('hex')
    ).toBe('c978edad9c8a6b2e93a4cb3016ab96ec');
    const originalPins = JSON.parse(
      read('scripts/ci/fixtures/launch-reset/pruner-lane/fixture-pins.json').toString()
    );
    for (const [path, digest] of Object.entries(originalPins)) {
      expect(
        createHash('sha256')
          .update(read('scripts/ci/fixtures/launch-reset/pruner-lane/' + path))
          .digest('hex')
      ).toBe(digest);
    }
  });
});
