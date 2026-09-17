/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ANNOUNCEMENT IS THE APPROVAL (2026-09-17)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-17: "REMOVE THIS GLOBALLY: human-only revert-approved. I don't
 * approve anything, when you are cleared to push and publish you do it
 * automatically." Agents own their releases end to end, so the Silent Revert
 * Guard no longer waits for a human label. An intended revert is cleared by
 * saying so: "revert" or [allow-revert] in a commit message, or in the pull
 * request title or body (REVERT_ANNOUNCED, set by the workflow). The
 * `revert-approved` label (REVERT_APPROVED) still clears it, for anyone who
 * applies one, but nothing requires it.
 *
 * What the guard still refuses is the SILENT restore of an older state, the
 * stale-checkout clobber it was written for (World Hub 902d8b2b).
 *
 * History: from 2026-09-01 the label was mandatory after an agent amended
 * [allow-revert] into its own message; on 2026-09-02 (#2676) the label was
 * made to work regardless of commit wording. Both are superseded by the rule
 * above. These run the real script against a throwaway repository so the pin
 * is on behaviour, not on the shape of the source.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
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

/** Run the guard; return the exit code (the script exits 1 on a finding). */
function guard(env: Record<string, string>): number {
  try {
    execFileSync('node', [SCRIPT, '--base', 'HEAD~1', '--days', '45'], {
      cwd: repo,
      env: cleanEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return 0;
  } catch (e: any) {
    return typeof e.status === 'number' ? e.status : 1;
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

describe('the announcement is the approval', () => {
  it('a silent restore of an older state, announced nowhere, is reported and the guard exits 1', () => {
    expect(guard({ REVERT_APPROVED: 'false', REVERT_ANNOUNCED: 'false' })).toBe(1);
  });

  it('the revert-approved label still clears it, whatever the commit said', () => {
    expect(guard({ REVERT_APPROVED: 'true', REVERT_ANNOUNCED: 'false' })).toBe(0);
  });

  it('the pull request saying "revert" clears it, whatever the commit said, with no label', () => {
    expect(guard({ REVERT_APPROVED: 'false', REVERT_ANNOUNCED: 'true' })).toBe(0);
  });

  it('a commit message saying "revert" IS the approval on its own', () => {
    writeFileSync(join(repo, 'guarded.yml'), 'name: three\n');
    git('commit', '-q', '-am', 'change again');
    writeFileSync(join(repo, 'guarded.yml'), 'name: one\n');
    git('commit', '-q', '-am', 'revert: back to one [allow-revert]');
    expect(guard({ REVERT_APPROVED: 'false', REVERT_ANNOUNCED: 'false' })).toBe(0);
  });

  it('an unannounced restore after an announced one is still reported', () => {
    writeFileSync(join(repo, 'guarded.yml'), 'name: four\n');
    git('commit', '-q', '-am', 'change to four');
    writeFileSync(join(repo, 'guarded.yml'), 'name: one\n');
    git('commit', '-q', '-am', 'chore: tidy');
    expect(guard({ REVERT_APPROVED: 'false', REVERT_ANNOUNCED: 'false' })).toBe(1);
  });
});
