import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const migration = read(
  'supabase/migrations/20260927165023_ordinary_eliminations_acquire_their_canonical_lane_before_ro.sql'
);

describe('ordinary elimination owns its original canonical transaction', () => {
  it('changes only the prefix before the first tournament row lock', () => {
    const rows = JSON.parse(
      read('scripts/ci/fixtures/elimination-canonical-lane/current-authorities-20260927.json')
    ).rows;
    const original = rows.find(
      (row: { proname: string }) => row.proname === 'fn_eliminate_tournament_player_atomic'
    ).definition;
    const seam = migration.match(/\$row_lock\$([\s\S]*?)\$row_lock\$/)![1];
    const replacement = migration.match(/\$canonical_lane\$([\s\S]*?)\$canonical_lane\$/)![1];
    const prefix = migration.match(/\$lane_prefix\$([\s\S]*?)\$lane_prefix\$/)![1];
    expect(replacement).toBe(prefix + seam);
    expect(original.split(seam)).toHaveLength(2);
    const candidate = original.replace(seam, replacement);
    expect(candidate.replace(prefix, '')).toBe(original);
    expect(createHash('md5').update(candidate).digest('hex')).toBe(
      'a5585b9d7fb061f12c29f1262a5a1b6c'
    );
    expect(candidate.indexOf('bubble_refund_requires_finalized_batch')).toBeLessThan(
      candidate.indexOf(prefix)
    );
    expect(prefix).toContain('IF p_tournament_id IS NOT NULL THEN');
    expect(prefix).toContain(
      'PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);'
    );
    expect(prefix).not.toMatch(/UPDATE|DELETE|INSERT|set_config|lock_timeout/);
    for (const row of rows) expect(migration).toContain(row.definition_md5);
  });

  it.each([
    'scripts/ci/test-elimination-canonical-lane.py',
    'scripts/ci/fixtures/elimination-canonical-lane/current-authorities-20260927.json',
    'scripts/ci/fixtures/elimination-canonical-lane/current-hand-lane.json',
    'scripts/ci/fixtures/elimination-canonical-lane/candidate-hand-commit.stdout',
    'scripts/ci/probes/elimination-canonical-lane.sql',
    'scripts/ci/probes/elimination-canonical-lane.spec',
    'tests/operations/elimination-canonical-lane-results.test.py',
    'tests/eliminationCanonicalLaneRegression.test.ts',
  ])('enforces native qualification for the individual changed input %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('runs complete native behavior and negative result parsing in the required accounting shard', () => {
    const ci = parse(read('.github/workflows/ci.yml'));
    const steps = ci.jobs.accounting_postgres.steps;
    const run = steps.filter((step: { id?: string }) => step.id === 'elimination_canonical_lane');
    expect(run).toHaveLength(1);
    expect(run[0].if).toBe('matrix.shard == 3');
    expect(run[0]['continue-on-error']).toBeUndefined();
    expect(run[0].run).toContain(
      'python3 tests/operations/elimination-canonical-lane-results.test.py'
    );
    expect(run[0].run).toContain('python3 scripts/ci/test-elimination-canonical-lane.py');
    expect(
      steps.some(
        (step: { if?: string; with?: Record<string, string> }) =>
          step.if?.includes('steps.elimination_canonical_lane.outcome') &&
          step.with?.['if-no-files-found'] === 'error'
      )
    ).toBe(true);
  });
});
