/**
 * The owner removed the manual approval dependency on 2026-09-17.
 * Exercise the actual reporter against an isolated real Git history: restored
 * content remains visible with or without old label variables, while execution
 * errors remain failures. No fixture commits may touch the owning worktree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gitFixtureEnvironment } from '../helpers/gitFixtureEnvironment';

const SCRIPT = resolve(__dirname, '../../scripts/ci/detect-silent-revert.mjs');
let repo: string;

/**
 * THE TEST MUST NOT COMMIT TO THE REPOSITORY IT LIVES IN (2026-09-02, learned
 * the expensive way). Husky exports GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE
 * into the pre-push hook. A child `git` that inherits them ignores its cwd and
 * operates on the REAL worktree - so the first version of this test, run by
 * the hook, made five fixture commits ("add guarded.yml", "revert: back to
 * one") on top of the agent's actual branch. Every git and node call below
 * therefore runs with those variables stripped, and `cwd` alone decides which
 * repository is touched.
 */
const cleanEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  gitFixtureEnvironment({ ...process.env, ...extra });

// Identity is passed per command with -c and NEVER written with `git config`:
// the first version of this test wrote user.name=test into whatever
// repository git resolved to, and that turned out to be the real one, shared
// by every worktree on the machine. Nothing here may persist anything.
const IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
const git = (...args: string[]) =>
  execFileSync('git', [...IDENTITY, ...args], {
    cwd: repo,
    env: cleanEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

/** Invoke the maintained entrypoint, retaining both findings and error output. */
function guard(env: Record<string, string> = {}, base = 'HEAD~1') {
  const result = spawnSync('node', [SCRIPT, '--base', base, '--days', '45'], {
    cwd: repo,
    env: cleanEnv(env),
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'revert-guard-'));
  git('init', '-q', '-b', 'main');
  // If GIT_DIR had leaked through, `rev-parse` would name the real repository
  // here rather than the temp one. Refuse to continue rather than commit into it.
  const top = realpathSync(git('rev-parse', '--show-toplevel').trim());
  const want = realpathSync(repo);
  if (top !== want) {
    throw new Error(`refusing to run: git resolved to ${top}, not the fixture ${want}`);
  }
  // v1, then v2, then a commit that puts the file back to EXACTLY v1. The
  // detector's definition of a revert is "restored to the content it had
  // before a prior commit changed it" (a bare deletion is deliberately not
  // one - it is visible in review). The restoring commit's message says
  // nothing about reverting, which is the case that was locked out.
  writeFileSync(join(repo, 'guarded.yml'), 'name: one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'add guarded.yml');
  writeFileSync(join(repo, 'guarded.yml'), 'name: two\n');
  git('commit', '-q', '-am', 'change guarded.yml');
  writeFileSync(join(repo, 'guarded.yml'), 'name: one\n');
  git('commit', '-q', '-am', 'chore: keep the shared script byte-identical');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('restored content is reported without a manual approval gate', () => {
  it('reports an exact restoration successfully without an approval label', () => {
    const result = guard();
    expect(result.status).toBe(0);
    expect(result.output).toContain('REVERT DETECTED');
    expect(result.output).toContain('guarded.yml');
    expect(result.output).toContain('change guarded.yml');
    expect(result.output).toContain('Advisory only:');
    expect(result.output).toContain('No approval label or additional human approval is required.');
  });

  it.each(['true', 'false'])('old label value %s cannot skip the actual scan', (value) => {
    const result = guard({ REVERT_APPROVED: value });
    expect(result.status).toBe(0);
    expect(result.output).toContain('REVERT DETECTED');
    expect(result.output).toContain('guarded.yml');
    expect(result.output).not.toContain('are not scanned');
  });

  it('announced restorations are still reported', () => {
    writeFileSync(join(repo, 'guarded.yml'), 'name: three\n');
    git('commit', '-q', '-am', 'change again');
    writeFileSync(join(repo, 'guarded.yml'), 'name: one\n');
    git('commit', '-q', '-am', 'revert: back to one [allow-revert]');
    const result = guard();
    expect(result.status).toBe(0);
    expect(result.output).toContain('REVERT DETECTED');
    expect(result.output).toContain('(announced in the message)');
  });

  it('a forward change does not produce a restoration finding', () => {
    writeFileSync(join(repo, 'guarded.yml'), 'name: forward\n');
    git('commit', '-q', '-am', 'move forward');
    const result = guard();
    expect(result.status).toBe(0);
    expect(result.output).toContain('no restored-file findings');
    expect(result.output).not.toContain('REVERT DETECTED');
  });

  it('an invalid history range fails instead of claiming a successful empty scan', () => {
    const result = guard({}, 'missing-history-reference');
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain('no restored-file findings');
  });
});
