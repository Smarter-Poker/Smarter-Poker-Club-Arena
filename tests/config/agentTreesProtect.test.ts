/**
 * A COPY OF EVERYTHING ONE `git reset --hard` AWAY FROM GONE (2026-10-01).
 *
 * scripts/agent-trees-protect.sh copies every worktree's unpushed commits,
 * tracked edits and untracked files into one folder, and must never change a
 * tree while it does. Each case is a real throwaway repository with a real
 * remote and a real worktree, because git ancestry is the thing under test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitFixtureEnvironment } from '../helpers/gitFixtureEnvironment';

const SCRIPT = path.resolve(__dirname, '../..', 'scripts/agent-trees-protect.sh');
let base: string;
let repo: string;
let tree: string;
let out: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: gitFixtureEnvironment() }).trim();

beforeAll(() => {
  // Real path: git names a worktree by it (macOS /tmp is /private/tmp).
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'protect-')));
  const remote = path.join(base, 'remote.git');
  repo = path.join(base, 'repo');
  tree = path.join(base, 'tree');
  out = path.join(base, 'out');
  git(base, 'init', '-q', '--bare', remote);
  git(base, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 'fixture@example.com');
  git(repo, 'config', 'user.name', 'Fixture');
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\nnode_modules/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'worktree', 'add', '-q', '-b', 'agent/work', tree);
  writeFileSync(path.join(tree, 'a.txt'), 'one\ntwo\n');
  git(tree, 'commit', '-q', '-am', 'unpushed work');
  writeFileSync(path.join(tree, 'a.txt'), 'one\ntwo\nthree, not committed\n');
  writeFileSync(path.join(tree, 'new.txt'), 'untracked\n');
  writeFileSync(path.join(tree, 'ignored.log'), 'ignored\n');
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('agent-trees-protect', () => {
  it('copies the commits no remote has, the edits and the untracked files, and changes nothing', () => {
    const headBefore = git(tree, 'rev-parse', 'HEAD');
    const statusBefore = git(tree, 'status', '--porcelain');
    execFileSync('bash', [SCRIPT, out], { cwd: repo, env: gitFixtureEnvironment() });
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(tree, 'status', '--porcelain')).toBe(statusBefore);

    const manifest = readFileSync(path.join(out, 'manifest.tsv'), 'utf8').trim().split('\n');
    const row = manifest.find((line) => line.startsWith(`${tree}\t`))!;
    expect(row).toBeTruthy();
    const [, branch, , unpushed, edited, untracked, files] = row.split('\t');
    expect(branch).toBe('agent/work');
    expect([unpushed, edited, untracked]).toEqual(['1', '1', '1']);
    const names = files.split(',');

    // The commit comes back from the bundle.
    const bundle = path.join(out, names.find((f) => f.endsWith('.bundle'))!);
    // The bundle carries only what no remote has, so it restores into any
    // clone of the repository, which already holds everything else.
    const restore = path.join(base, 'restore');
    git(base, 'clone', '-q', path.join(base, 'remote.git'), restore);
    git(restore, 'fetch', '-q', bundle, 'HEAD:refs/heads/recovered');
    expect(git(restore, 'log', '-1', '--format=%s', 'recovered')).toBe('unpushed work');

    // The edit applies on top of it, and the untracked file is in the archive.
    const patch = readFileSync(path.join(out, names.find((f) => f.endsWith('.patch'))!), 'utf8');
    expect(patch).toContain('+three, not committed');
    const tgz = path.join(out, names.find((f) => f.endsWith('.untracked.tgz'))!);
    const listed = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' });
    expect(listed).toContain('new.txt');
    expect(listed).not.toContain('ignored.log');
  });

  it('skips a clean tree and anything under a skipped prefix', () => {
    const again = path.join(base, 'out-skip');
    execFileSync('bash', [SCRIPT, again, '--skip-prefix', tree], {
      cwd: repo,
      env: gitFixtureEnvironment(),
    });
    const manifest = readFileSync(path.join(again, 'manifest.tsv'), 'utf8');
    expect(manifest).not.toContain(`${tree}\t`);
    // The main checkout is clean and fully pushed: no row, no files.
    expect(manifest.trim().split('\n')).toHaveLength(1);
    expect(existsSync(path.join(again, 'manifest.tsv'))).toBe(true);
  });
});
