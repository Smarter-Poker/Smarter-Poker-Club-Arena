import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

const root = resolve(__dirname, '../..');
const runnerPath = 'scripts/dev/probe-terminal-bounty-candidate-coverage-pg17.sh';
const fixturePath =
  'scripts/dev/fixtures/terminal-bounty-candidate-coverage/chests-only-pre-money.sql';
const migrationPath =
  'supabase/migrations/20261022234954_chests_only_pre_money_knockouts_do_not_block_terminal_comple.sql';

describe('pre-money terminal regression executes in required accounting qualification', () => {
  it.each([runnerPath, fixturePath, migrationPath])('selects accounting for %s', (path) => {
    expect(classifyChangedPaths([path]).server).toBe(true);
  });

  it('runs the exact migration and native regression through the existing accounting job', () => {
    const workflow = parse(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'));
    const step = workflow.jobs.accounting_postgres.steps.find(
      (value: { name?: string }) =>
        value.name === 'Tournament residuals require complete bounty candidate coverage'
    );
    expect(step.if).toBe('matrix.shard == 4');
    expect(step.run).toBe(`bash ${runnerPath}`);
    const runner = readFileSync(resolve(root, runnerPath), 'utf8');
    expect(runner).toContain(`P -f "$ROOT/${migrationPath}"`);
    expect(runner).toContain('P -f "$FIX/chests-only-pre-money.sql"');
    expect(runner.indexOf(`P -f "$ROOT/${migrationPath}"`)).toBeLessThan(
      runner.indexOf('P -f "$FIX/chests-only-pre-money.sql"')
    );
  });
});
