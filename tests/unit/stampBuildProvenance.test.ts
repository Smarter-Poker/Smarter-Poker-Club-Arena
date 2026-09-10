import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const script = path.resolve('scripts/stamp-build-provenance.mjs');
const fixtures: string[] = [];

// Each subprocess sees only its temporary repository. Runner git context and
// CI flags must not change the scenario or expose the enclosing worktree.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith('GIT_') &&
      ![
        'GITHUB_ACTIONS',
        'GITHUB_RUN_ID',
        'GITHUB_REPOSITORY',
        'STRICT_PROVENANCE',
        'CA_DIST',
      ].includes(key)
  )
);
const fixtureEnv = {
  ...cleanEnv,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function directory() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ca-provenance-test-'));
  fixtures.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]) {
  const result = spawnSync('git', args, {
    cwd: dir,
    env: fixtureEnv,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Fixture git ${args[0]} failed: ${result.error ?? result.stderr}`);
  }
  return result.stdout.trim();
}

function repository(state: 'current' | 'behind' | 'ahead' | 'diverged' | 'no-remote') {
  const dir = directory();
  git(dir, 'init', '--quiet', '--initial-branch=main');
  git(dir, 'config', 'user.name', 'Smarter-Poker');
  git(dir, 'config', 'user.email', '254329056+Smarter-Poker@users.noreply.github.com');
  git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'fixture base');
  const base = git(dir, 'rev-parse', 'HEAD');
  if (state !== 'no-remote') git(dir, 'update-ref', 'refs/remotes/origin/main', base);
  if (state === 'behind' || state === 'diverged') {
    git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'fixture main advancement');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'checkout', '--quiet', '--detach', base);
  }
  if (state === 'ahead' || state === 'diverged') {
    git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'fixture branch advancement');
  }
  return dir;
}

function shallowMerge(mainDepth: 'shallow' | 'full') {
  const source = repository('current');
  for (let i = 0; i < 3; i++) {
    git(source, 'commit', '--quiet', '--allow-empty', '-m', `fixture main ${i}`);
  }
  git(source, 'checkout', '--quiet', '-b', 'feature');
  git(source, 'commit', '--quiet', '--allow-empty', '-m', 'fixture feature');
  git(source, 'checkout', '--quiet', 'main');
  git(source, 'commit', '--quiet', '--allow-empty', '-m', 'fixture main parent');
  const main = git(source, 'rev-parse', 'HEAD');
  git(source, 'checkout', '--quiet', '-b', 'pr');
  git(source, 'merge', '--quiet', '--no-ff', 'feature', '-m', 'fixture PR merge');
  const dir = directory();
  git(
    dir,
    '-c',
    'protocol.file.allow=always',
    'clone',
    '--quiet',
    '--depth=1',
    '--single-branch',
    '--branch=pr',
    pathToFileURL(source).href,
    '.'
  );
  git(
    dir,
    '-c',
    'protocol.file.allow=always',
    'fetch',
    '--quiet',
    ...(mainDepth === 'shallow' ? ['--depth=1'] : []),
    'origin',
    'main:refs/remotes/origin/main'
  );
  expect(git(dir, 'cat-file', '-p', 'HEAD')).toContain(`parent ${main}`);
  expect(git(dir, 'rev-parse', '--is-shallow-repository')).toBe('true');
  return { source, dir };
}

function stamp(dir: string, overrides: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [script], {
    cwd: dir,
    env: { ...fixtureEnv, ...overrides },
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  const artifact = path.join(dir, overrides.CA_DIST || 'dist', 'ca-provenance.json');
  expect(existsSync(artifact)).toBe(true);
  return { ...result, info: JSON.parse(readFileSync(artifact, 'utf8')) };
}

describe('actual build provenance subprocess', () => {
  it.each([
    ['GitHub Actions', { GITHUB_ACTIONS: 'true' }],
    ['strict local release', { STRICT_PROVENANCE: '1' }],
  ])('refuses stale source in %s and retains its diagnostic artifact', (_name, env) => {
    const dir = repository('behind');
    const result = stamp(dir, env);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain('1 commit(s) BEHIND origin/main');
    expect(result.stdout).not.toContain('bypassed');
    expect(result.info).toMatchObject({
      commit: git(dir, 'rev-parse', 'HEAD'),
      behindMain: 1,
      aheadMain: 0,
    });
  });

  it('refuses a divergent CI checkout despite an additional branch commit', () => {
    const result = stamp(repository('diverged'), { GITHUB_ACTIONS: 'true' });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.info).toMatchObject({ behindMain: 1, aheadMain: 1 });
  });

  it.each([{}, { STRICT_PROVENANCE: '0' }])(
    'keeps a stale local diagnostic build usable: %j',
    (env) => {
      const result = stamp(repository('behind'), env);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('1 commit(s) BEHIND origin/main');
      expect(result.info).toMatchObject({ behindMain: 1, builtBy: 'local' });
    }
  );

  it('accepts current CI source with the exact source and run identity', () => {
    const dir = repository('current');
    const result = stamp(dir, {
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'Smarter-Poker/Smarter-Poker-Club-Arena',
      GITHUB_RUN_ID: '12345',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.info).toMatchObject({
      schema: 1,
      commit: git(dir, 'rev-parse', 'HEAD'),
      commitTime: git(dir, 'show', '-s', '--format=%cI', 'HEAD'),
      branch: 'main',
      dirty: false,
      behindMain: 0,
      aheadMain: 0,
      builtBy: 'github-actions',
      ciRun: 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/12345',
    });
  });

  it('accepts an ahead-only strict build and preserves the native output directory', () => {
    const dir = repository('ahead');
    const result = stamp(dir, { STRICT_PROVENANCE: '1', CA_DIST: 'dist-native' });
    expect(result.status).toBe(0);
    expect(result.info).toMatchObject({ behindMain: 0, aheadMain: 1 });
    expect(existsSync(path.join(dir, 'dist'))).toBe(false);
  });

  it.each(['shallow', 'full'] as const)(
    'refuses incomplete PR ancestry with %s main history, then accepts the same unshallowed merge',
    (mainDepth) => {
      const { source, dir } = shallowMerge(mainDepth);
      // Both runner histories falsely count main as behind its own merge.
      expect(Number(git(dir, 'rev-list', '--count', 'HEAD..origin/main'))).toBeGreaterThan(0);
      const incomplete = stamp(dir, { GITHUB_ACTIONS: 'true' });
      expect(incomplete.status).toBe(1);
      expect(incomplete.stderr).toContain('incomplete Git history');
      expect(incomplete.stderr).not.toContain('commit(s) BEHIND');
      expect(incomplete.info).toMatchObject({
        historyComplete: false,
        behindMain: null,
        aheadMain: null,
      });
      git(dir, '-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--unshallow', 'origin');
      const complete = stamp(dir, { GITHUB_ACTIONS: 'true' });
      expect(complete.status, complete.stdout + complete.stderr).toBe(0);
      expect(complete.info).toMatchObject({
        commit: incomplete.info.commit,
        historyComplete: true,
        behindMain: 0,
      });
      // Complete history must still reject real subsequent main advancement.
      git(source, 'checkout', '--quiet', 'main');
      git(source, 'commit', '--quiet', '--allow-empty', '-m', 'fixture newer main');
      git(
        dir,
        '-c',
        'protocol.file.allow=always',
        'fetch',
        '--quiet',
        'origin',
        'main:refs/remotes/origin/main'
      );
      const stale = stamp(dir, { GITHUB_ACTIONS: 'true' });
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain('1 commit(s) BEHIND origin/main');
    }
  );

  it('warns on shallow local diagnostics but refuses a strict local release', () => {
    const { dir } = shallowMerge('shallow');
    const local = stamp(dir);
    expect(local.status).toBe(0);
    expect(local.stderr).toContain('incomplete Git history');
    expect(local.info).toMatchObject({ historyComplete: false, behindMain: null });
    const strict = stamp(dir, { STRICT_PROVENANCE: '1' });
    expect(strict.status).toBe(1);
    expect(strict.stderr).toContain('incomplete Git history');
  });

  it('preserves unknown-distance diagnostics when origin/main is unavailable', () => {
    const result = stamp(repository('no-remote'), { STRICT_PROVENANCE: '1' });
    expect(result.status).toBe(0);
    expect(result.info).toMatchObject({ behindMain: null, aheadMain: null });
    expect(result.stdout).toContain('behind-main=?');
  });

  it('preserves the documented non-git diagnostic artifact', () => {
    const result = stamp(directory(), { GITHUB_ACTIONS: 'true' });
    expect(result.status).toBe(0);
    expect(result.info).toMatchObject({
      commit: 'unknown',
      commitTime: 'unknown',
      branch: 'unknown',
      behindMain: null,
      aheadMain: null,
    });
  });
});
