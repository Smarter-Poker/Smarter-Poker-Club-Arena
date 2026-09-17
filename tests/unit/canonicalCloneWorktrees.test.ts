import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const guard = resolve('scripts/check-canonical-clone.sh');
const env = { ...process.env };
for (const key of ['CI', 'GITHUB_ACTIONS', 'AGENT_CLONE_OK', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
let fixture: string;
let clone: string;
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
};
const check = (cwd: string) => spawnSync('bash', [guard], { cwd, env, encoding: 'utf8' });

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'canonical-clone-guard-'));
  clone = join(fixture, '.agent-trees', 'ordinary-clone');
  mkdirSync(clone, { recursive: true });
  git(clone, 'init', '--initial-branch=main');
  git(clone, 'remote', 'add', 'origin', 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena.git');
  git(clone, '-c', 'user.name=Guard Fixture', '-c', 'user.email=guard-fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'isolated fixture');
});
afterEach(() => rmSync(fixture, { recursive: true, force: true }));

describe('canonical-clone guard identifies worktrees from Git', () => {
  it('allows an isolated linked worktree outside the legacy path, including SSD-style paths', () => {
    const owned = join(fixture, 'agent-work', 'owned');
    git(clone, 'worktree', 'add', '--detach', owned);
    expect(check(owned).status).toBe(0);
  });

  it('does not accept an ordinary clone merely because its path contains .agent-trees', () => {
    const disguisedStatus = check(clone).status;
    const ordinaryPath = join(fixture, 'ordinary-clone');
    renameSync(clone, ordinaryPath);
    expect(disguisedStatus).toBe(check(ordinaryPath).status);
    // Even hosts without this Mac's canonical path enforce isolation in the
    // next, existing hook. A directory name cannot satisfy that guard either.
    const sharedGuard = resolve('scripts/guard-shared-clone.sh');
    expect(spawnSync('bash', [sharedGuard], { cwd: ordinaryPath, env }).status).toBe(1);
  });
});
