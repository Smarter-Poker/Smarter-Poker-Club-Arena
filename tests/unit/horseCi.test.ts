import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { classifyChangedPaths, classifyGitChanges } from '../../scripts/ci/classify-ci-changes.mjs';

const root = resolve(__dirname, '../..');
const ci = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));

type GitFixture = {
  directory: string;
  base: string;
  git: (...args: string[]) => string;
  write: (name: string, value?: string) => void;
  commit: () => string;
};

function withGitFixture(check: (fixture: GitFixture) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'horse-ci-git-'));
  try {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
    const write = (name: string, value = 'fixture') => {
      const path = join(directory, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, value);
    };
    const commit = () => {
      git('add', '--all');
      git(
        '-c',
        'user.name=Horse CI Test',
        '-c',
        'user.email=horse-ci@invalid',
        'commit',
        '-qm',
        'fixture commit'
      );
      return git('rev-parse', 'HEAD');
    };
    git('init', '-q');
    write('docs/baseline.md');
    const base = commit();
    check({ directory, git, write, commit, base });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('Horse Phase 4 changes admit their PostgreSQL parent job', () => {
  it.each([
    'scripts/ci/probes/horse-phase4-certified-solver/run-pg17.sh',
    'scripts/ci/probes/horse-phase4-certified-solver/certified-v31.sql',
    'scripts/ci/probes/horse-phase4-certified-solver/setup.sql',
    'scripts/ci/probes/horse-phase4-certified-solver/README.md',
  ])('selects both the parent and Phase 4 step for a sole probe edit: %s', (path) => {
    expect(classifyChangedPaths([path])).toEqual({
      src: false,
      server: true,
      tests: false,
      phase4: true,
      fixture: false,
    });
  });

  it.each([
    'server/src/engine/HorseLogic.ts',
    'server/src/services/GtoPostflopV31Loader.ts',
    'supabase/migrations/20260909175000_v31_control_receipts_use_exact_json_types.sql',
    '.github/workflows/ci.yml',
    'scripts/ci/classify-ci-changes.mjs',
  ])('preserves parent and step selection for an existing Phase 4 path: %s', (path) => {
    const flags = classifyChangedPaths([path]);
    expect(flags.phase4).toBe(true);
    expect(flags.server).toBe(true);
  });

  it.each([
    'docs/horse-phase4.md',
    'scripts/ci/probes/horse-phase4-certified-solver-other/setup.sql',
    'tests/e2e/live-animations.spec.ts',
    'operations/release/fixture/safeupdate-provider.mjs',
  ])('does not widen server or Phase 4 selection for an unrelated path: %s', (path) => {
    const flags = classifyChangedPaths([path]);
    expect(flags.phase4).toBe(false);
    expect(flags.server).toBe(false);
  });

  it('retains both selections when a probe is renamed out of the protected path', () => {
    withGitFixture(({ directory, git, write, commit }) => {
      const probe = 'scripts/ci/probes/horse-phase4-certified-solver/certified-v31.sql';
      write(probe);
      const base = commit();
      git('mv', probe, 'docs/retired-phase4-example.sql');
      const result = classifyGitChanges({ cwd: directory, base, head: commit() });
      expect(result.complete).toBe(true);
      expect(result.paths).toContain(probe);
      expect(result.flags.phase4).toBe(true);
      expect(result.flags.server).toBe(true);
    });
  });
});

describe('Horse commitment audit remains in the existing accounting PostgreSQL gate', () => {
  it.each([
    'scripts/ci/test-horse-commitment-audit.py',
    'scripts/ci/probes/horse-commitment-audit/bootstrap.sql',
    'scripts/ci/probes/horse-commitment-audit/setup.sql',
    'scripts/ci/probes/horse-commitment-audit/original-r1-function.sql',
    'scripts/ci/probes/horse-commitment-audit/format-and-commitment.sql',
    'scripts/ci/probes/horse-commitment-audit/roster-identity.sql',
    'scripts/ci/probes/horse-commitment-audit/reader-auth.sql',
    'scripts/ci/probes/horse-commitment-audit/reader-page.sql',
    'scripts/ci/probes/horse-commitment-audit/README.md',
    'supabase/migrations/20260914161209_horse_committed_pot_daily_audit.sql',
    'supabase/migrations/20260917051350_horse_commitment_reviews_preserve_format_and_canonical_rosters.sql',
    'supabase/migrations/20260917050940_horse_private_commitment_review_reader.sql',
    'tests/unit/horseCi.test.ts',
  ])('admits the parent job and routing tests for a sole dependency edit: %s', (path) => {
    const flags = classifyChangedPaths([path]);
    expect(flags.server).toBe(true);
    expect(flags.tests).toBe(true);
    expect(flags.phase4).toBe(false);
  });

  it.each([
    'scripts/ci/test-horse-commitment-audit.py.example',
    'scripts/ci/probes/horse-commitment-audit-other/setup.sql',
    'docs/horse-commitment-audit.md',
  ])('does not admit accounting for an unrelated neighbor: %s', (path) => {
    expect(classifyChangedPaths([path]).server).toBe(false);
  });

  it('retains admission when a daily fixture is renamed out of the protected path', () => {
    withGitFixture(({ directory, git, write, commit }) => {
      const fixture = 'scripts/ci/probes/horse-commitment-audit/roster-identity.sql';
      write(fixture);
      const base = commit();
      git('mv', fixture, 'docs/retired-daily-example.sql');
      const result = classifyGitChanges({ cwd: directory, base, head: commit() });
      expect(result.complete).toBe(true);
      expect(result.paths).toContain(fixture);
      expect(result.flags.server).toBe(true);
      expect(result.flags.tests).toBe(true);
    });
  });

  it('runs the finite daily fixture unconditionally within the admitted accounting job', () => {
    const job = ci.jobs.accounting_postgres;
    const steps = job.steps.filter((step: { run?: string }) =>
      step.run?.includes('python3 -B scripts/ci/test-horse-commitment-audit.py')
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].if).toBeUndefined();
    expect(steps[0]['continue-on-error']).toBeUndefined();
    expect(steps[0].env.PG_BIN).toBe('/usr/lib/postgresql/17/bin');
    expect(steps[0].run).toContain('--source-root "$GITHUB_WORKSPACE"');
    expect(steps[0].run).toContain('--allocation-parent /tmp');
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(ci.jobs.server_shards.needs).toContain('accounting_postgres');
  });
});

it('runs the hook-selection laws for a pre-push-only edit', () => {
  expect(classifyChangedPaths(['.husky/pre-push'])).toEqual({
    src: false,
    server: false,
    tests: true,
    phase4: false,
    fixture: false,
  });
});
