import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve(process.cwd(), 'scripts/stamp-build-provenance.mjs');
const repos: string[] = [];
// Git exports repository-local GIT_* variables to hooks. This law runs from
// pre-push, so carrying those variables into a temporary fixture would point
// its git commands back at the caller's real worktree.
const isolatedGitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
);

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: isolatedGitEnv,
  }).trim();

const makeRepo = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ca-provenance-'));
  repos.push(cwd);
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'provenance-test@smarter.poker');
  git(cwd, 'config', 'user.name', 'Provenance Test');
  writeFileSync(join(cwd, 'source.txt'), 'first\n');
  git(cwd, 'add', 'source.txt');
  git(cwd, 'commit', '-qm', 'first');
  const old = git(cwd, 'rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'source.txt'), 'second\n');
  git(cwd, 'commit', '-qam', 'second');
  const current = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'update-ref', 'refs/remotes/origin/main', current);
  return { cwd, old, current };
};

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe('Club Arena build provenance', () => {
  it('fails closed when strict publication is behind origin/main', () => {
    const { cwd, old } = makeRepo();
    git(cwd, 'checkout', '-q', '-b', 'stale-feature', old);

    const result = spawnSync(process.execPath, [script], {
      cwd,
      encoding: 'utf8',
      env: { ...isolatedGitEnv, STRICT_PROVENANCE: '1', CA_DIST: 'dist' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BEHIND origin/main');
    expect(result.stdout).not.toContain('bypassed');
  }, 30_000);

  it('allows the exact source at origin/main', () => {
    const { cwd, current } = makeRepo();
    git(cwd, 'checkout', '-q', '-b', 'current-feature', current);

    const result = spawnSync(process.execPath, [script], {
      cwd,
      encoding: 'utf8',
      env: { ...isolatedGitEnv, STRICT_PROVENANCE: '1', CA_DIST: 'dist' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('behind-main=0');
  }, 30_000);
});
