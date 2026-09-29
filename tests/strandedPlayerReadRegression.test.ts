import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const read = (p: string) => readFileSync(p, 'utf8');
describe('stranded-player audit native enforcement', () => {
  it.each([
    'scripts/ci/test-stranded-player-read-postgres.py',
    'scripts/ci/fixtures/stranded-player-read/installed.sql',
    'tests/strandedPlayerReadRegression.test.ts',
  ])('requires database qualification for isolated input %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('executes the actual fixture in the existing required PostgreSQL job', () => {
    const workflow = parse(read('.github/workflows/ci.yml'));
    const steps = workflow.jobs.accounting_postgres.steps.filter((s: { run?: string }) =>
      s.run?.includes('test-stranded-player-read-postgres.py')
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      if: 'matrix.shard == 4',
      run: 'python3 scripts/ci/test-stranded-player-read-postgres.py',
    });
  });

  it('binds the exact installed read and refuses source drift', () => {
    const paths = readdirSync('supabase/migrations').filter((p) =>
      p.endsWith('_stranded_player_audit_examines_history_only_after_excluding_.sql')
    );
    expect(paths).toHaveLength(1);
    const baseline = read('scripts/ci/fixtures/stranded-player-read/installed.sql');
    expect(createHash('md5').update(baseline).digest('hex')).toBe(
      '5dc2f495fb115311c61fbf057456c225'
    );
    const sql = read('supabase/migrations/' + paths[0]);
    expect(sql).toContain('STRANDED_PLAYER_READ_SOURCE_CHANGED');
    expect(sql).toContain('STRANDED_PLAYER_READ_POSTIMAGE_CHANGED');
    expect(sql).toContain('5dc2f495fb115311c61fbf057456c225');
    const old = sql.match(/\$old\$([\s\S]*?)\$old\$/)![1];
    const next = sql.match(/\$new\$([\s\S]*?)\$new\$/)![1];
    expect(baseline.split(old)).toHaveLength(2);
    // Materialization must not alter the returned finding or aggregate.
    const resultStart = '\n  SELECT s.id, s.name, count(*)';
    expect(next.slice(next.indexOf(resultStart))).toBe(old.slice(old.indexOf(resultStart)));
    expect(next).toContain('WITH unseated AS MATERIALIZED (');
    expect(next).toContain('stranded AS MATERIALIZED (');
  });
});
