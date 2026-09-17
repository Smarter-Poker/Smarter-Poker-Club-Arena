import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitFixtureEnvironment } from '../helpers/gitFixtureEnvironment';

const roots: string[] = [];
const repository = resolve(__dirname, '../..');
// Test setup must remain safe even if the helper under test is broken. Never
// use the real hook environment to create the outside marker repository.
const setupEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: devNull,
  GIT_CONFIG_GLOBAL: devNull,
};
const identity = ['-c', 'user.name=Fixture isolation', '-c', 'user.email=fixture@example.invalid'];
function git(cwd: string, args: string[], env = setupEnv) {
  return execFileSync('git', [...identity, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 10_000,
  }).trim();
}
function initialize(cwd: string) {
  mkdirSync(cwd);
  git(cwd, ['init', '-q']);
  writeFileSync(join(cwd, 'owned.txt'), 'This repository belongs only to the test.\n');
  git(cwd, ['add', 'owned.txt']);
  git(cwd, ['commit', '-qm', 'outside marker']);
}
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'ca-git-env-'));
  roots.push(root);
  const outside = join(root, 'outside');
  initialize(outside);
  git(outside, ['config', 'fixture.outsideMarker', 'must-survive']);
  git(outside, ['update-ref', 'refs/heads/outside-marker', 'HEAD']);
  const hooks = join(root, 'hooks');
  mkdirSync(hooks);
  const marker = join(root, 'hook-ran');
  writeFileSync(
    join(hooks, 'post-commit'),
    '#!/bin/sh\nprintf hook > "$CA_FIXTURE_HOOK_MARKER"\n',
    {
      mode: 0o755,
    }
  );
  const config = join(root, 'outside.gitconfig');
  git(root, ['config', '--file', config, 'core.hooksPath', hooks]);
  git(root, ['config', '--file', config, 'fixture.injected', 'must-not-load']);
  const snapshot = () => ({
    config: readFileSync(join(outside, '.git/config'), 'utf8'),
    injectedConfig: readFileSync(config, 'utf8'),
    refs: git(outside, ['for-each-ref', '--format=%(refname) %(objectname)']),
    head: git(outside, ['rev-parse', 'HEAD']),
    status: git(outside, ['status', '--porcelain']),
  });
  const before = snapshot();
  return { root, outside, hooks, marker, config, snapshot, before };
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('disposable Git fixture environment', () => {
  it('reads current inputs, keeps ordinary test variables, and removes every Git override', () => {
    const inherited = { PATH: 'test-path', REVERT_APPROVED: 'true', GIT_CONFIG_COUNT: '1' };
    const first = gitFixtureEnvironment(inherited);
    inherited.GIT_CONFIG_COUNT = '2';
    const second = gitFixtureEnvironment({ ...inherited, GIT_FUTURE_SELECTOR: 'outside' });
    expect(first).not.toBe(second);
    expect(second).toEqual({
      PATH: 'test-path',
      REVERT_APPROVED: 'true',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: devNull,
      GIT_CONFIG_GLOBAL: devNull,
    });
    expect(inherited.GIT_CONFIG_COUNT).toBe('2');
  });

  it.each(['repository selectors', 'injected configuration', 'configuration files'])(
    'real init, config, commit and ref writes ignore inherited %s',
    (kind) => {
      const s = sandbox();
      const inherited: NodeJS.ProcessEnv = {
        ...setupEnv,
        CA_FIXTURE_HOOK_MARKER: s.marker,
      };
      if (kind === 'repository selectors') {
        Object.assign(inherited, {
          GIT_DIR: join(s.outside, '.git'),
          GIT_COMMON_DIR: join(s.outside, '.git'),
          GIT_WORK_TREE: s.outside,
          GIT_INDEX_FILE: join(s.outside, '.git/index'),
          GIT_OBJECT_DIRECTORY: join(s.outside, '.git/objects'),
          GIT_ALTERNATE_OBJECT_DIRECTORIES: join(s.outside, '.git/objects'),
          GIT_NAMESPACE: 'outside',
          GIT_PREFIX: 'outside/',
          GIT_TEMPLATE_DIR: s.hooks,
        });
      } else if (kind === 'injected configuration') {
        Object.assign(inherited, {
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: 'core.hooksPath',
          GIT_CONFIG_VALUE_0: s.hooks,
          GIT_CONFIG_KEY_1: 'core.bare',
          GIT_CONFIG_VALUE_1: 'true',
          GIT_CONFIG_PARAMETERS: "'core.bare=true'",
        });
      } else {
        Object.assign(inherited, {
          GIT_CONFIG: join(s.outside, '.git/config'),
          GIT_CONFIG_GLOBAL: s.config,
          GIT_CONFIG_SYSTEM: s.config,
          GIT_CONFIG_NOSYSTEM: '0',
        });
      }
      const fixture = join(s.root, 'fixture');
      mkdirSync(fixture);
      const env = gitFixtureEnvironment(inherited);
      git(fixture, ['init', '-q'], env);
      git(fixture, ['config', 'fixture.owned', 'only-here'], env);
      writeFileSync(join(fixture, 'source.txt'), 'An actual disposable commit.\n');
      git(fixture, ['add', 'source.txt'], env);
      git(fixture, ['commit', '-qm', 'isolated'], env);
      git(fixture, ['update-ref', 'refs/heads/fixture-owned', 'HEAD'], env);
      expect(git(fixture, ['config', '--global', '--list'], env)).toBe('');
      expect(git(fixture, ['config', '--system', '--list'], env)).toBe('');
      expect(git(fixture, ['config', '--local', 'fixture.owned'], env)).toBe('only-here');
      expect(git(fixture, ['rev-parse', '--is-bare-repository'], env)).toBe('false');
      expect(s.snapshot()).toEqual(s.before);
      expect(existsSync(s.marker)).toBe(false);
    }
  );

  it('rejects an executable injected hook, with a positive control in a separate fixture', () => {
    const s = sandbox();
    const control = join(s.root, 'control');
    initialize(control);
    const injected = {
      ...setupEnv,
      CA_FIXTURE_HOOK_MARKER: s.marker,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: s.hooks,
    };
    git(control, ['commit', '--allow-empty', '-qm', 'positive hook control'], injected);
    expect(readFileSync(s.marker, 'utf8')).toBe('hook');
    rmSync(s.marker);
    git(
      control,
      ['commit', '--allow-empty', '-qm', 'isolated hook'],
      gitFixtureEnvironment(injected)
    );
    expect(existsSync(s.marker)).toBe(false);
    expect(s.snapshot()).toEqual(s.before);
  });

  it('the three real guard suites preserve the outside repository under a hostile hook environment', () => {
    const s = sandbox();
    const result = spawnSync(
      process.execPath,
      [
        join(repository, 'node_modules/vitest/vitest.mjs'),
        'run',
        'tests/unit/theAnnouncementIsTheApproval.test.ts',
        'tests/config/orphanedWorkGuard.test.ts',
        'tests/unit/buildProvenanceRefusesStaleSource.test.ts',
      ],
      {
        cwd: repository,
        env: {
          ...setupEnv,
          CA_FIXTURE_HOOK_MARKER: s.marker,
          GIT_DIR: join(s.outside, '.git'),
          GIT_COMMON_DIR: join(s.outside, '.git'),
          GIT_WORK_TREE: s.outside,
          GIT_CONFIG: join(s.outside, '.git/config'),
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.hooksPath',
          GIT_CONFIG_VALUE_0: s.hooks,
          GIT_CONFIG_GLOBAL: s.config,
          GIT_CONFIG_SYSTEM: s.config,
        },
        encoding: 'utf8',
        timeout: 60_000,
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(s.snapshot()).toEqual(s.before);
    expect(existsSync(s.marker)).toBe(false);
  }, 65_000);
});
