import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

const fixture = 'scripts/ci/fixtures/hand-prune-one-page.sql';
const migration =
  'supabase/migrations/20261029154153_hand_history_pruning_commits_one_raw_page_before_releasing_m.sql';

describe('one-page retention stays in required native accounting', () => {
  it.each([fixture, migration])('selects accounting for %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('executes the source-bound candidate once in shard four', () => {
    const workflow = parse(
      readFileSync(resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8')
    );
    const steps = workflow.jobs.accounting_postgres.steps.filter((step: { run?: string }) =>
      step.run?.includes(fixture)
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBe('matrix.shard == 4');
    expect(steps[0]['continue-on-error']).toBeUndefined();
    expect(steps[0].run).toContain('--candidate ' + migration);
    expect(steps[0].run).toContain('run_launch_reset_accounting_fixture.py');
  });
});
