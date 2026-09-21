import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

const directory = 'scripts/ci/probes/f06-shared-hand-lane/';
const migration =
  'supabase/migrations/20260919034506_retired_original_owner_accepts_sealed_zero_on_another_origin.sql';

describe('retired original other-table zero proof enforcement', () => {
  it('keeps the checked forward migration reproducible without editing prior migrations', () => {
    expect(() =>
      execFileSync('python3', [directory + 'build-retired-other-zero-migration.py', '--check'])
    ).not.toThrow();
    const sql = readFileSync(migration, 'utf8');
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(sql).toContain('CREATE OR REPLACE FUNCTION smarter_private.f06_retired_origin_snapshot');
  });

  it('runs the native proof inside the existing required original-owner qualification', () => {
    const runner = readFileSync('scripts/ci/test-f06-shared-hand-lane.py', 'utf8');
    const owner = readFileSync(directory + 'retired_origin_qualification.py', 'utf8');
    expect(runner).toContain(
      "retired['qualify'](ROOT, out, cmd, command, run, probe, require, results)"
    );
    expect(owner).toContain(
      "other_zero['qualify'](root, out, cmd, command, run, probe, require, results)"
    );
    expect(owner).toContain("results.get('retiredOtherZero', {}).get('passed') is True");
    for (const path of [
      migration,
      ...[
        'build-retired-other-zero-migration.py',
        'retired-other-zero-proof.sql',
        'retired-other-zero-fixture.sql',
        'retired_other_zero_qualification.py',
      ].map((name) => directory + name),
    ]) {
      expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
    }
  });
});
