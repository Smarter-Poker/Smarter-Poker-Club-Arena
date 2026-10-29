import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

  it('uses the existing required actions owner and retains the nested progress artifact', () => {
    const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
    const steps = ci.jobs.accounting_postgres.steps.filter((step: { run?: string }) =>
      step.run?.includes('scripts/ci/test-superseded-horse-actions.py')
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBe('matrix.shard == 3');
    expect(steps[0]['continue-on-error']).toBeUndefined();
    expect(steps[0].run).toContain('--pg-bin "$POKER_AUDIT_PG_BIN"');
    expect(steps[0].run).toContain('--evidence artifacts/superseded-horse-actions');
    expect(ci.jobs.accounting_postgres.steps).toContainEqual(
      expect.objectContaining({
        uses: 'actions/upload-artifact@v4',
        with: expect.objectContaining({ path: 'artifacts/superseded-horse-actions/' }),
      })
    );
    const driver = readFileSync('scripts/ci/test-superseded-horse-actions.py', 'utf8');
    expect(driver).toContain('run_retention_progress(args.pg_bin, out)');
    expect(driver.indexOf('run_retention_progress(args.pg_bin, out)')).toBeLessThan(
      driver.indexOf("e.report['status'] = 'passed'")
    );
    expect(driver).toContain("if __name__ == '__main__':");
  });

  it('executes the child with the same PostgreSQL binary and propagates a real nonzero failure', () => {
    execFileSync(
      'python3',
      [
        '-B',
        '-c',
        `
import sys, pathlib, subprocess
from unittest.mock import patch
sys.path.insert(0, 'scripts/ci')
from satellite_qualifier_fixture import module
owner = module(pathlib.Path('scripts/ci/test-superseded-horse-actions.py').resolve(), 'retention_owner_contract')
with patch.object(owner.subprocess, 'run') as run:
    owner.run_retention_progress(pathlib.Path('/native/pg17'), pathlib.Path('/evidence/actions'))
    command = run.call_args.args[0]
    assert command[0] == sys.executable
    assert command[1].endswith('/scripts/ci/test-superseded-retention-progress.py')
    assert command[2:] == ['--pg-bin', '/native/pg17', '--evidence', '/evidence/actions/retention-progress']
    assert run.call_args.kwargs == {'check': True}
with patch.object(owner.subprocess, 'run', side_effect=subprocess.CalledProcessError(7, ['child'])):
    try:
        owner.run_retention_progress(pathlib.Path('/native/pg17'), pathlib.Path('/evidence/actions'))
    except subprocess.CalledProcessError as error:
        assert error.returncode == 7
    else:
        raise AssertionError('Child failure was swallowed')
`,
      ],
      { stdio: 'pipe' }
    );
  });
});
