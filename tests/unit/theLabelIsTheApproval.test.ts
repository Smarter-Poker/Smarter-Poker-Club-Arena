/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE REVERT-APPROVED LABEL IS THE APPROVAL (2026-09-02)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED on #2676. The Silent Revert Guard flagged a pull request that
 * deleted a redundant workflow file. The `revert-approved` label was applied
 * at 18:41; the guard re-ran on `labeled` at 18:42 with REVERT_APPROVED=true
 * in its environment and exited 1 anyway.
 *
 * The label only exempted a commit whose MESSAGE also contained the word
 * "revert". CLAUDE.md 10.8.2 and the guard's own issue text promise "apply the
 * label and the check passes" and say nothing about the message; 10.8.2 also
 * forbids editing commit messages to route around the guard. So a human's
 * approval could not be acted on. A gate whose approved path cannot be taken
 * is a lock.
 *
 * These run the real script against a throwaway repository so the pin is on
 * behaviour, not on the shape of the source.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../scripts/ci/detect-silent-revert.mjs');
let repo: string;

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

/** Run the guard; return the exit code (the script exits 1 on a finding). */
function guard(env: Record<string, string>): number {
  try {
    execFileSync('node', [SCRIPT, '--base', 'HEAD~1', '--days', '45'], {
      cwd: repo,
      env: { ...process.env, ...env },
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
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
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

describe('the revert-approved label is the approval', () => {
  it('without the label, a deletion is reported and the guard exits 1', () => {
    expect(guard({ REVERT_APPROVED: 'false' })).toBe(1);
  });

  it('WITH the label, the same pull request passes - whatever the commit said', () => {
    // The message above contains no "revert" and no [allow-revert]. Before
    // 2026-09-02 this returned 1 with the label on, which is the bug.
    expect(guard({ REVERT_APPROVED: 'true' })).toBe(0);
  });

  it('a commit message saying "revert" is NOT an approval on its own', () => {
    // 2026-08-31: an agent wrote [allow-revert] into its own message to get
    // past the guard. Announcing must never substitute for the label.
    writeFileSync(join(repo, 'guarded.yml'), 'name: three\n');
    git('commit', '-q', '-am', 'change again');
    writeFileSync(join(repo, 'guarded.yml'), 'name: one\n');
    git('commit', '-q', '-am', 'revert: back to one [allow-revert]');
    expect(guard({ REVERT_APPROVED: 'false' })).toBe(1);
  });
});
