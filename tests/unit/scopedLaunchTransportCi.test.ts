import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';
const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path));
const fixture = 'scripts/ci/fixtures/launch-reset/transport-boundary/';
describe('The scoped launch transport regressions reach required accounting', () => {
  it.each([
    'floor-json-fixture.json',
    'escrow-table.sql',
    'typed-escrow-witness.sql',
    'fixture-pins.json',
  ])('selects accounting for %s', (name) => {
    expect(classifyChangedPaths([fixture + name])).toMatchObject({ server: true, tests: true });
  });
  it('the existing full qualification consumes both exact migrations once', () => {
    const workflow = read('.github/workflows/ci.yml').toString();
    const call = workflow
      .split('\n')
      .filter((line) => line.includes('python3 -B scripts/ci/test_launch_reset_balance.py'));
    expect(call).toHaveLength(1);
    expect(call[0]).toContain('--candidate-migration "$launch_candidate"');
    expect(call[0]).toContain(
      '--followup-migration supabase/migrations/20261013133012_scoped_launch_operator_accepts_authoritative_json_claims.sql'
    );
    expect(call[0]).toContain('--production-roster');
    const pins = JSON.parse(read(fixture + 'fixture-pins.json').toString());
    for (const [name, sha] of Object.entries(pins))
      expect(
        createHash('sha256')
          .update(read(fixture + name))
          .digest('hex')
      ).toBe(sha);
    const driver = read('scripts/ci/test_launch_reset_balance.py').toString();
    expect(driver).toContain('components.append(args.followup_migration.resolve())');
    expect(driver).toContain(
      'source_hashes={str(p):hashlib.sha256(component_sources[p].encode()).hexdigest() for p in components}'
    );
  });
});
