import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path));
const base = 'scripts/ci/fixtures/launch-reset/pruner-lane/';

describe('The original pruner admission has required native regression coverage', () => {
  it.each(['qualify.py', 'witness.mjs', 'original.sql', 'expected.sql', 'fixture-pins.json'])(
    'selects required accounting for %s',
    (path) => {
      expect(classifyChangedPaths([base + path])).toMatchObject({ server: true, tests: true });
    }
  );

  it('the existing required installer qualification invokes the exact migration once', () => {
    const driver = read('scripts/ci/test_launch_reset_installer.py').toString();
    expect(driver.match(/pruner-lane\/qualify\.py/g)).toHaveLength(1);
    expect(driver).toContain(
      '20261013115251_hand_history_pruner_respects_the_existing_settlement_install.sql'
    );
    expect(driver).toContain('check=True,timeout=120');
    expect(driver).toContain("a.output.with_name('pruner-lane.json')");
  });

  it('binds the actual original definitions and concurrent witness', () => {
    const pins = JSON.parse(read(base + 'fixture-pins.json').toString());
    for (const [path, digest] of Object.entries(pins)) {
      expect(
        createHash('sha256')
          .update(read(base + path))
          .digest('hex')
      ).toBe(digest);
    }
    const original = read(base + 'original.sql').toString();
    const expected = read(base + 'expected.sql').toString();
    const admission =
      '  -- Preserve the original maintenance/settlement owner before any ledger read.\n  IF pg_catalog.pg_try_advisory_xact_lock_shared(530090,1) IS NOT TRUE THEN RETURN 0; END IF;\n';
    expect(expected.replace(admission, '')).toBe(original);
  });
});
