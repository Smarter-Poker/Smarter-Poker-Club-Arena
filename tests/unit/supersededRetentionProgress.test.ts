import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

describe('superseded action retention progress remains enforced', () => {
  it('budgets raw discovery chunks without changing its existing job', () => {
    const sql = readFileSync(
      'supabase/migrations/20261029083417_retention_discovery_commits_bounded_chunks_within_its_budget.sql',
      'utf8'
    );
    expect(sql).toContain("'b7eae030b437b830695a3bac6f78f821'");
    expect(sql).toContain('LIMIT 250');
    expect(sql).toContain('total_count>=5000');
    expect(sql).toContain("interval '900 milliseconds'");
    expect(sql).toContain('clock_timestamp()+longest_chunk>=deadline');
    expect(sql).toContain('longest_chunk:=greatest(longest_chunk,clock_timestamp()-chunk_started)');
    expect(sql).not.toMatch(/cron\.alter_job|CREATE (?:TABLE|INDEX)/);
  });

  it('binds the uninstalled migration to independently captured exact cron bytes', () => {
    const capture = JSON.parse(
      readFileSync('scripts/ci/fixtures/superseded-action-preimages.json', 'utf8')
    ).retention_cron_preimage;
    expect(Buffer.byteLength(capture.command)).toBe(301);
    expect(createHash('md5').update(capture.command).digest('hex')).toBe(
      '96244362bf46b39e75ef1100b1372203'
    );
    expect(capture.command_md5).toBe('96244362bf46b39e75ef1100b1372203');
    const sql = readFileSync(
      'supabase/migrations/20261028215328_superseded_action_retention_progresses_at_its_existing_owner.sql',
      'utf8'
    );
    expect(sql.match(/expected text:=\$original\$([\s\S]*?)\$original\$/)?.[1]).toBe(
      capture.command
    );
  });

  it.each([
    'scripts/ci/test-superseded-retention-progress.py',
    'tests/unit/supersededRetentionProgress.test.ts',
  ])('selects required accounting for input-only change %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('runs the exact physical queue exit upgrade inside the existing native owner', () => {
    const driver = readFileSync('scripts/ci/test-superseded-retention-progress.py', 'utf8');
    expect(driver).toContain(
      'supabase/migrations/20261029200737_physically_impossible_superseded_action_work_exits_its_exist.sql'
    );
    expect(driver).toContain('e.sql(base,file=queue_exit_migration');
    expect(driver).toContain('e.sql(empty,file=queue_exit_migration');
    expect(driver).toContain('[migration,budget_migration,queue_exit_migration,actions.PREFLIGHT,');
    expect(driver).toContain('BEFORE physical impossible queue entry is deferred daily');
    expect(driver).toContain('AFTER only physical impossible queue bookkeeping exits');
    expect(driver).toContain('locked physical impossible source keeps its future retry entry');
    expect(driver).toContain('queue exit rollback restores exact bookkeeping source and receipt');
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
import sys, pathlib, subprocess, tempfile
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
with tempfile.TemporaryDirectory(prefix='retention-child-contract-', dir=pathlib.Path.cwd()) as scratch:
    root = pathlib.Path(scratch)
    child = root / 'scripts/ci/test-superseded-retention-progress.py'
    child.parent.mkdir(parents=True)
    child.write_text("import sys; assert sys.argv[1:] == ['--pg-bin', '/native/pg17', '--evidence', '/evidence/actions/retention-progress']; sys.exit(7)")
    with patch.object(owner, 'ROOT', root):
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
