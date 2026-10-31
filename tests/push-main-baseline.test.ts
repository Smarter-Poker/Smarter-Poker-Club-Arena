import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Git exports repository-local variables to hooks. Fixtures must never inherit
// a hook's real Git directory, index, worktree or command-scoped configuration.
const fixtureEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
);
const helper = resolve('scripts/ci/resolve-push-main.mjs');
const hook = readFileSync('.husky/pre-push', 'utf8');
const ssh = 'git@github.com:Smarter-Poker/Smarter-Poker-Club-Arena.git';
const https = 'https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena.git';
function fixture(run: (f: ReturnType<typeof create>) => void) {
  const f = create();
  try {
    run(f);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
}
function create() {
  const dir = mkdtempSync(join(tmpdir(), 'push-main-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      env: fixtureEnv,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q');
  const tree = git('mktree');
  const commit = (message: string, parent?: string) => {
    const args = ['commit-tree', tree, '-m', message];
    if (parent) args.push('-p', parent);
    return execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...fixtureEnv,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.test',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.test',
      },
    }).trim();
  };
  const old = commit('stale local main');
  git('update-ref', 'refs/heads/main', old);
  const main = commit('protected main', old);
  const head = commit('branch', main);
  git('update-ref', 'refs/heads/feature', head);
  git('symbolic-ref', 'HEAD', 'refs/heads/feature');
  git('remote', 'add', 'origin', ssh);
  git('update-ref', 'refs/remotes/origin/main', main);
  const resolveMain = (remote = 'origin', url = https) =>
    spawnSync(process.execPath, [helper, remote, url], {
      cwd: dir,
      env: fixtureEnv,
      encoding: 'utf8',
    });
  return { dir, git, old, main, head, resolveMain };
}

describe('push destination tracking main', () => {
  it('uses named remotes and URL pushes across SSH/HTTPS and approved transfer names', () =>
    fixture((f) => {
      for (const [remote, url] of [
        ['origin', ssh],
        [https, https],
        [
          'ssh://git@github.com/Smarter-Software-PIQ/Smarter-Poker-Club-Arena.git',
          'ssh://git@github.com/Smarter-Software-PIQ/Smarter-Poker-Club-Arena.git',
        ],
      ]) {
        const result = f.resolveMain(remote, url);
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe(f.main);
      }
    }));
  it('does not associate a fork or a pushurl with another repository fetch ref', () =>
    fixture((f) => {
      const fork = 'https://github.com/Someone/Smarter-Poker-Club-Arena.git';
      f.git('remote', 'add', 'fork', fork);
      f.git('update-ref', 'refs/remotes/fork/main', f.old);
      expect(f.resolveMain(fork, fork).stdout.trim()).toBe(f.old);
      expect(f.resolveMain(https, https).stdout.trim()).toBe(f.main);
      f.git('config', 'remote.origin.pushurl', fork);
      expect(f.resolveMain('origin', fork).status).toBe(2);
    }));
  it('refuses ambiguous, unmatched and missing tracking main rather than stale local main', () =>
    fixture((f) => {
      expect(f.resolveMain('unknown', 'https://github.com/Unknown/Unmatched.git').status).toBe(2);
      f.git('remote', 'add', 'duplicate', https);
      f.git('update-ref', 'refs/remotes/duplicate/main', f.main);
      expect(f.resolveMain(https, https).stdout.trim()).toBe(f.main);
      f.git('update-ref', 'refs/remotes/duplicate/main', f.old);
      expect(f.resolveMain(https, https).status).toBe(2);
      expect(f.resolveMain('origin', https).stdout.trim()).toBe(f.main);
      f.git('update-ref', '-d', 'refs/remotes/origin/main');
      const missing = f.resolveMain('origin', https);
      expect(missing.status).toBe(2);
      expect(missing.stderr).toContain('UNKNOWN');
      expect(missing.stdout).toBe('');
    }));
  it('honors effective URL rewrites, refuses mixed push destinations and never echoes URL credentials', () =>
    fixture((f) => {
      f.git('config', 'url.https://github.com/.insteadOf', 'git@github.com:');
      expect(f.resolveMain(https, https).stdout.trim()).toBe(f.main);
      f.git('config', '--add', 'remote.origin.pushurl', https);
      f.git('config', '--add', 'remote.origin.pushurl', 'https://github.com/Other/Fork.git');
      expect(f.resolveMain('origin', https).status).toBe(2);
      const bad = f.resolveMain(
        'https://private:secret@example.test/repo',
        'https://private:secret@example.test/repo'
      );
      expect(bad.status).toBe(2);
      expect(bad.stderr).not.toContain('secret');
    }));
  it('captures one commit even if the tracking ref advances afterwards', () =>
    fixture((f) => {
      const captured = f.resolveMain().stdout.trim();
      f.git('update-ref', 'refs/remotes/origin/main', f.head);
      expect(captured).toBe(f.main);
      expect(f.git('merge-base', f.head, captured)).toBe(f.main);
    }));
  it('executes actual hook range/filter/migration selectors for new and missing-tip URL pushes', () =>
    fixture((f) => {
      // Add inherited and branch migrations to real trees, with stale local main.
      mkdirSync(join(f.dir, 'supabase/migrations'), { recursive: true });
      writeFileSync(join(f.dir, 'supabase/migrations/inherited.sql'), '-- inherited\n');
      f.git('add', '.');
      const tree = f.git('write-tree');
      const makeCommit = (t: string, parent: string) =>
        execFileSync('git', ['commit-tree', t, '-p', parent, '-m', 'fixture'], {
          cwd: f.dir,
          encoding: 'utf8',
          env: {
            ...fixtureEnv,
            GIT_AUTHOR_NAME: 'Fixture',
            GIT_AUTHOR_EMAIL: 'fixture@example.test',
            GIT_COMMITTER_NAME: 'Fixture',
            GIT_COMMITTER_EMAIL: 'fixture@example.test',
          },
        }).trim();
      const main = makeCommit(tree, f.old);
      f.git('update-ref', 'refs/remotes/origin/main', main);
      writeFileSync(join(f.dir, 'supabase/migrations/branch.sql'), '-- branch\n');
      f.git('add', '.');
      const head = makeCommit(f.git('write-tree'), main);
      f.git('update-ref', 'refs/heads/feature', head);
      const marker = '  # Git passes a literal URL as $1';
      const start = hook.indexOf(marker);
      const end = hook.indexOf('  ALL_FILES="$ALL_FILES', start);
      expect(start).toBeGreaterThan(0);
      const migration = hook.slice(
        hook.indexOf('  MIGRATION_BASE='),
        hook.indexOf('  if [ -z "$MIGRATION_BASE" ]')
      );
      for (const remoteSha of ['0'.repeat(40), 'f'.repeat(40), main]) {
        const result = spawnSync(
          'bash',
          [
            '-c',
            'set -e\ngit() { if [ "$1" = fetch ]; then return 1; fi; command git "$@"; }\n' +
              hook.slice(start, end) +
              '\n' +
              migration +
              '\nprintf "MIGRATION=%s\\nFILES=%s\\n" "$MIGRATION_BASE" "$FILES"',
          ],
          {
            cwd: f.dir,
            encoding: 'utf8',
            env: {
              ...fixtureEnv,
              CA_TREE_TOP: resolve('.'),
              LOCAL_SHA: head,
              REMOTE_SHA: remoteSha,
              REMOTE: https,
              URL: https,
              PUSH_MAIN_TIP: '',
            },
          }
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(`MIGRATION=${main}`);
        expect(result.stdout).toContain('supabase/migrations/branch.sql');
        expect(result.stdout).not.toContain('supabase/migrations/inherited.sql');
      }
      // The previous literal-URL lookup fails and selects stale local main,
      // demonstrably scanning inherited migration(s) as well as the branch one.
      const oldBase = execFileSync(
        'bash',
        [
          '-c',
          'git merge-base "$LOCAL_SHA" "$REMOTE/main" 2>/dev/null || git merge-base "$LOCAL_SHA" main',
        ],
        { cwd: f.dir, encoding: 'utf8', env: { ...fixtureEnv, LOCAL_SHA: head, REMOTE: https } }
      ).trim();
      expect(oldBase).toBe(f.old);
      expect(f.git('diff', '--name-only', oldBase, head).split('\n')).toHaveLength(2);
      expect(f.git('diff', '--name-only', main, head).split('\n')).toEqual([
        'supabase/migrations/branch.sql',
      ]);
    }));
  it('keeps actual destination fetch/merged guard and non-fast-forward checks wired', () => {
    expect(hook).toContain('"${REMOTE_REF#refs/heads/}" "$REMOTE" "$URL"');
    expect(hook).toContain('git fetch -q "$REMOTE" "$REMOTE_SHA"');
    expect(hook).toContain('git merge-base --is-ancestor "$REMOTE_SHA" "$LOCAL_SHA"');
    expect(hook.match(/resolve-push-main\.mjs/g)).toHaveLength(1);
    expect(hook).not.toMatch(/merge-base "\$LOCAL_SHA" (?:"\$REMOTE\/main"|main)/);
    expect(hook).toContain('node scripts/ci/check-migrations-applied.mjs "$MIGRATION_BASE"');
  });
});
