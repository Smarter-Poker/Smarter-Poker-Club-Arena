import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('durable original continuation qualification remains connected', () => {
  it.each([
    'scripts/ci/test-hand-continuation.py',
    'scripts/ci/probes/hand-continuation-native.sql',
    'scripts/ci/fixtures/hand-continuation/financial-preimages.json',
    'scripts/ci/fixtures/hand-continuation/disposition.spec',
    'scripts/ci/schema-manifest.d/hand-continuation.json',
    'supabase/migrations/20261028233353_durable_private_hand_continuation.sql',
  ])('executes required accounting for changes to %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('runs the local real PostgreSQL owner in required accounting shard three', () => {
    const workflow = parse(read('.github/workflows/ci.yml'));
    const steps = workflow.jobs.accounting_postgres.steps.filter((step: { run?: string }) =>
      step.run?.includes('scripts/ci/test-hand-continuation.py')
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBe('matrix.shard == 3');
    expect(steps[0]['continue-on-error']).toBeUndefined();
    expect(steps[0].run).toContain('--socket-root "$RUNNER_TEMP"');
    expect(steps[0].env.PG_ISOLATION_TESTER).toContain('isolationtester');
  });

  it('keeps the captured current financial owner bodies exact', () => {
    const captures = JSON.parse(
      read('scripts/ci/fixtures/hand-continuation/financial-preimages.json')
    );
    expect(captures).toHaveLength(4);
    for (const row of captures) {
      const body = /AS (\$[A-Za-z_0-9]*\$)([\s\S]*?)\1/.exec(row.definition)?.[2];
      expect(body).toBeDefined();
      expect(createHash('md5').update(body!).digest('hex')).toBe(row.body_md5);
      expect(row.owner).toBe('postgres');
      expect(row.proacl).toBe(
        row.signature.startsWith('fn_ca_settle_hand_stacks_absolute(')
          ? '{postgres=X/postgres}'
          : '{postgres=X/postgres,service_role=X/postgres}'
      );
    }
  });
});
