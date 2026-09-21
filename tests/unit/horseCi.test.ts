import { describe, expect, it, vi } from 'vitest';

// Subprocess contract suite: these tests drive REAL child processes, so their
// wall time scales with machine load, not with the code under test. vitest's
// 5000ms default is a UNIT-test budget: the slowest test here measures 402ms
// solo, and the pre-push hook runs this file in a 90-file suite at full width,
// where contention has been measured to stretch these runs by 7.1x and time
// them out. 90s is 223x the measured solo runtime - past anything observed,
// and still a real bound, so a genuinely hung child still fails the suite.
// File-scoped on purpose: no global testTimeout, no --no-file-parallelism.
vi.setConfig({ testTimeout: 90_000 });
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import {
  classifyChangedPaths,
  classifyGitChanges,
  gitEnvironmentForCwd,
} from '../../scripts/ci/classify-ci-changes.mjs';

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
      execFileSync('git', args, {
        cwd: directory,
        env: gitEnvironmentForCwd(),
        encoding: 'utf8',
      }).trim();
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

describe('Horse Git fixtures stay inside their disposable repository', () => {
  it.each([false, true])(
    'isolates horse fixture writes from hook context (extended=%s)',
    (extended) => {
      const decoy = mkdtempSync(join(tmpdir(), 'horse-ci-outer-git-'));
      // Always create the outer decoy with explicit isolation. The negative
      // control must never inherit a hook's real repository, even if the
      // withGitFixture implementation under test loses its environment guard.
      const outerGit = (...args: string[]) =>
        execFileSync('git', args, {
          cwd: decoy,
          env: gitEnvironmentForCwd(),
          encoding: 'utf8',
        }).trim();
      try {
        outerGit('init', '-q');
        writeFileSync(join(decoy, 'sentinel.txt'), 'outer repository must not change');
        outerGit('add', '--all');
        outerGit(
          '-c',
          'user.name=Horse CI Test',
          '-c',
          'user.email=horse-ci@invalid',
          'commit',
          '-qm',
          'outer sentinel'
        );
        const head = outerGit('rev-parse', 'HEAD');
        const gitDirectory = join(decoy, '.git');
        const files = ['config', 'index', 'HEAD'];
        const before = files.map((file) => readFileSync(join(gitDirectory, file)));
        try {
          for (const key of Object.keys(process.env)) {
            if (key.startsWith('GIT_')) vi.stubEnv(key, undefined);
          }
          vi.stubEnv('GIT_DIR', gitDirectory);
          if (extended) {
            for (const [key, value] of Object.entries({
              GIT_WORK_TREE: decoy,
              GIT_COMMON_DIR: gitDirectory,
              GIT_INDEX_FILE: join(gitDirectory, 'index'),
              GIT_OBJECT_DIRECTORY: join(gitDirectory, 'objects'),
              GIT_ALTERNATE_OBJECT_DIRECTORIES: join(gitDirectory, 'objects'),
              GIT_CONFIG_COUNT: '1',
              GIT_CONFIG_KEY_0: 'core.bare',
              GIT_CONFIG_VALUE_0: 'true',
              GIT_CONFIG_PARAMETERS: "'core.bare=true'",
            }))
              vi.stubEnv(key, value);
          }
          withGitFixture(({ directory, git, write, commit, base }) => {
            expect(realpathSync(git('rev-parse', '--absolute-git-dir'))).toBe(
              join(realpathSync(directory), '.git')
            );
            expect(git('rev-parse', '--is-bare-repository')).toBe('false');
            const probe = 'scripts/ci/probes/horse-commitment-audit/roster-identity.sql';
            write(probe);
            const result = classifyGitChanges({ cwd: directory, base, head: commit() });
            expect(result.complete).toBe(true);
            expect(result.paths).toEqual([probe]);
            expect(result.flags.server).toBe(true);
            expect(result.flags.tests).toBe(true);
          });
        } finally {
          vi.unstubAllEnvs();
        }
        expect(outerGit('rev-parse', 'HEAD')).toBe(head);
        expect(outerGit('status', '--porcelain')).toBe('');
        files.forEach((file, index) => {
          expect(readFileSync(join(gitDirectory, file))).toEqual(before[index]);
        });
      } finally {
        rmSync(decoy, { recursive: true, force: true });
      }
    }
  );
});

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
    'supabase/migrations/20260917052511_horse_private_commitment_review_reader.sql',
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
    expect(ci.jobs.server.needs).toContain('accounting_postgres');
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

it('runs the real-Git report regressions for a detector-only edit', () => {
  expect(classifyChangedPaths(['scripts/ci/detect-silent-revert.mjs'])).toEqual({
    src: false,
    server: false,
    tests: true,
    phase4: false,
    fixture: false,
  });
});
