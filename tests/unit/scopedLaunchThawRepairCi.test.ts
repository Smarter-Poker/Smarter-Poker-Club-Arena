import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THAW_REPAIR_FILE, validateThawRepair } from '../../scripts/ci/maintenance-thaw-repair.mjs';
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const source = read('supabase/migrations/' + THAW_REPAIR_FILE);
const normal = {
  dryRun: false,
  settlementLane: false,
  recovery: null,
  batches: null,
  preamble: [],
};
describe('The original installer owns the exact expired thaw repair', () => {
  it('accepts only its protected source and refuses changed bytes or another migration', () => {
    expect(() => validateThawRepair(THAW_REPAIR_FILE, source, normal)).not.toThrow();
    expect(() => validateThawRepair(THAW_REPAIR_FILE, source + '\n', normal)).toThrow(
      'exact 33012'
    );
    expect(() => validateThawRepair('20261013133013_other.sql', source, normal)).toThrow(
      'exact 33012'
    );
  });
  it.each(['dryRun', 'settlementLane', 'recovery', 'batches'])(
    'refuses combined %s requests',
    (flag) => {
      expect(() =>
        validateThawRepair(THAW_REPAIR_FILE, source, { ...normal, [flag]: true })
      ).toThrow('exact 33012');
    }
  );
  it('refuses a concurrent index preamble', () => {
    expect(() =>
      validateThawRepair(THAW_REPAIR_FILE, source, { ...normal, preamble: [{}] })
    ).toThrow('exact 33012');
  });
  it('runs the native repair and retains the original installer qualification in the existing driver', () => {
    const driver = read('scripts/ci/test_launch_reset_installer.py');
    expect(driver).toContain("copy_module('maintenance-thaw-repair.mjs')");
    expect(driver).toContain('scripts/ci/fixtures/launch-reset/maintenance-thaw-repair/qualify.py');
    expect(driver).toContain('original_window_refusal_sends_nothing');
    expect(driver).toContain('check=True,timeout=120');
  });
  it('binds every captured original SQL fixture before opening the isolated database', () => {
    const dir = 'scripts/ci/fixtures/launch-reset/maintenance-thaw-repair/';
    const pins = JSON.parse(read(dir + 'fixture-pins.json'));
    expect(Object.keys(pins).sort()).toEqual(
      readdirSync(resolve(process.cwd(), dir))
        .filter((x) => x.endsWith('.sql'))
        .sort()
    );
    for (const [name, hash] of Object.entries(pins))
      expect(
        createHash('sha256')
          .update(readFileSync(resolve(process.cwd(), dir + name)))
          .digest('hex')
      ).toBe(hash);
    const qualifier = read(dir + 'qualify.py');
    expect(qualifier.indexOf('Original thaw fixture bytes changed')).toBeLessThan(
      qualifier.indexOf('initdb')
    );
    expect(qualifier).toContain('missing_original_audit_rolls_back');
  });
});
