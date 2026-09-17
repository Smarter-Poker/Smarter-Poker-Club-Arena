/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DETECTED REVERT IS REPORTED, NOT GATED (2026-09-17)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * History: from 2026-09-01 the Silent Revert Guard blocked a pull request
 * that restored a file to an earlier state until Dan applied a
 * `revert-approved` label (and on 2026-09-02 the label itself could not clear
 * it, which this file first pinned). On 2026-09-17 Dan removed the human gate
 * globally: "I don't approve anything. When you are cleared to push and
 * publish, you do it automatically."
 *
 * So the guard is a reporter. It still finds the restored file, prints the
 * finding in full and emits a `::warning` annotation for the pull request,
 * and then EXITS 0. No environment variable, label or commit-message token
 * changes that. These run the real script against a throwaway repository so
 * the pin is on behaviour, not on the shape of the source.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs';
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

/** Run the guard; return the exit code and what it printed. */
function guard(env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [SCRIPT, '--base', 'HEAD~1', '--days', '45'], {
      cwd: repo,
      env: cleanEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    return { code: 0, stdout, stderr: '' };
  } catch (e: any) {
    return {
      code: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
    };
  }
}

beforeAll(() => {
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

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('a detected revert is reported, not gated', () => {
  it('a restored file is reported as a warning annotation and the guard exits 0', () => {
    const run = guard({});
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/::warning title=Revert detected::guarded\.yml/);
  });

  it('no label or environment variable is consulted any more', () => {
    expect(guard({ REVERT_APPROVED: 'false' }).code).toBe(0);
    expect(guard({ REVERT_APPROVED: 'true' }).code).toBe(0);
    const workflow = readFileSync(
      resolve(__dirname, '../../.github/workflows/silent-revert-guard.yml'),
      'utf8'
    );
    expect(workflow).not.toMatch(/REVERT_APPROVED/);
    expect(workflow).not.toMatch(/types:.*labeled/);
    expect(workflow).not.toMatch(/gh issue create/);
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).not.toMatch(/process\.env\.REVERT_APPROVED/);
    expect(script).not.toMatch(/process\.exit\(1\)/);
  });

  it('an announced revert is reported the same way, and still passes', () => {
    writeFileSync(join(repo, 'guarded.yml'), 'name: three\n');
    git('commit', '-q', '-am', 'change again');
    writeFileSync(join(repo, 'guarded.yml'), 'name: one\n');
    git('commit', '-q', '-am', 'revert: back to one [allow-revert]');
    const run = guard({});
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/::warning title=Revert detected::guarded\.yml/);
  });
});
