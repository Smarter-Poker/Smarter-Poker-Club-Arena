import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { classifyChangedPaths } from '../scripts/ci/classify-ci-changes.mjs';

const read = (path: string) => readFileSync(path, 'utf8');
const migration = read(
  'supabase/migrations/20260927165228_union_administrator_directory_binds_the_signed_in_operator.sql'
);

describe('caller-bound union administrator directory qualification', () => {
  it.each([
    'scripts/ci/test-union-admin-directory.py',
    'scripts/ci/fixtures/union-admin-directory/arena-name.sql',
    'tests/unionAdminDirectoryRegression.test.ts',
  ])('enforces native qualification for an isolated input %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });

  it('runs real role and revocation qualification in the existing required accounting job', () => {
    const steps = parse(read('.github/workflows/ci.yml')).jobs.accounting_postgres.steps.filter(
      (step: { run?: string }) => step.run?.includes('test-union-admin-directory.py')
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBe('matrix.shard == 4');
    expect(steps[0].run).toBe('python3 scripts/ci/test-union-admin-directory.py');
    const runner = read('scripts/ci/test-union-admin-directory.py');
    expect(runner).toContain("expected, 'authenticator'");
    expect(runner).toContain('NOSUPERUSER BYPASSRLS');
    expect(runner).toContain('original() == baseline');
    expect(runner).toContain('writer.wait(timeout=10)');
    expect(runner).toContain('MIGRATION.read_text()');
  });

  it('binds only the signed-in operator, preserves table authority and pins the safe name helper', () => {
    expect(migration).toContain('v_user_id uuid := auth.uid()');
    expect(migration).toContain('own_admin.user_id = v_user_id');
    expect(migration).toContain("own_admin.role IN ('union_lead', 'union_admin')");
    expect(migration).toContain('u.owner_id = v_user_id');
    expect(migration).not.toMatch(
      /p_user_id|ALTER TABLE|CREATE POLICY|ALTER PUBLICATION|INSERT INTO|UPDATE public|DELETE FROM/i
    );
    expect(migration).toContain('STABLE SECURITY DEFINER');
    expect(migration).toContain('SET search_path = public, pg_temp');
    expect(migration).toContain('FROM PUBLIC, anon');
    expect(migration).toContain('TO authenticated, service_role');
    expect(migration).toContain(
      createHash('md5')
        .update(read('scripts/ci/fixtures/union-admin-directory/arena-name.sql'))
        .digest('hex')
    );
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
  });
});
