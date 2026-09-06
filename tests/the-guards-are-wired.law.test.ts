/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: A GUARD THAT IS NOT WIRED IN IS A FILE, NOT A GUARD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `estate-integrity.sh` puts it exactly right, about a different failure:
 *
 *   "Every loss this estate has taken came from a protection that existed
 *    somewhere and was not actually in force where it mattered: hooks that
 *    guarded one machine because they were untracked; an Autopilot rolled to
 *    seven repos that queued nothing in six; a required check that could not be
 *    required because the gate behind it was red for an unrelated reason."
 *
 * `scripts/guard-merged-branch.sh` is one HTTP request standing between an
 * agent and work that disappears while git reports success. It only does that
 * from `.husky/pre-push`. Deleting the call is a one-line diff that reads like
 * tidying, and nothing else in the repo would notice.
 *
 * So this pins the wiring, not the implementation - the script may be rewritten
 * freely, but it must still be invoked, and it must still fail open.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const GUARD_PATH = 'scripts/guard-merged-branch.sh';
const HOOK_PATH = '.husky/pre-push';

describe('LAW - the merged-branch guard is wired into the push path', () => {
  it('the guard exists and is executable', () => {
    expect(existsSync(resolve(root, GUARD_PATH)), `${GUARD_PATH} is missing`).toBe(true);
    // A hook calls it with `bash <path>`, so the mode bit is not load-bearing
    // for correctness - but a non-executable guard is a sign it was recreated
    // by a copy that also lost something else.
    const mode = statSync(resolve(root, GUARD_PATH)).mode;
    expect(mode & 0o111, `${GUARD_PATH} is not executable`).toBeGreaterThan(0);
  });

  it('pre-push actually invokes it', () => {
    const hook = read(HOOK_PATH);
    expect(hook, 'the pre-push hook no longer calls guard-merged-branch.sh').toMatch(
      /guard-merged-branch\.sh/
    );
  });

  it('it runs BEFORE the expensive suites, so a doomed push fails in seconds', () => {
    const hook = read(HOOK_PATH);
    const guardAt = hook.indexOf('guard-merged-branch.sh');
    // The first thing in this hook that costs real time. If the guard sits
    // after it, an agent waits three minutes to be told the push cannot land.
    const testsAt = hook.search(/vitest|npx tsc|running the tests/);
    expect(guardAt, 'guard not found').toBeGreaterThan(-1);
    if (testsAt > -1) {
      expect(guardAt, 'the guard must run before the test suites').toBeLessThan(testsAt);
    }
  });

  it('FAILS OPEN - no token, no network, or an unreadable answer must allow the push', () => {
    /**
     * The most important property, and the easiest to lose in a "make it
     * stricter" pass. A guard that blocks every push when GitHub is
     * unreachable is a worse outage than the bug it prevents, and the first
     * person to hit it will delete the guard rather than debug it.
     */
    const guard = read(GUARD_PATH);
    // No token -> exit 0
    expect(guard).toMatch(/\[ -z "\$TOKEN" \] && exit 0/);
    // No response -> exit 0
    expect(guard).toMatch(/\[ -z "\$RESP" \] && exit 0/);
    // Nothing definite to say -> exit 0
    expect(guard).toMatch(/\[ -z "\$VERDICT" \] && exit 0/);
    // And the only exit 1 is the deliberate refusal at the very end.
    const exits = guard.match(/^exit 1$/gm) || [];
    expect(exits.length, 'the guard should refuse in exactly one place').toBe(1);
  });

  it('it can find the token from inside a worktree, where .env does not exist', () => {
    /**
     * The first version of this guard looked only at `--show-toplevel`/.env.
     * Every agent works in a `git worktree add` checkout and .env is gitignored,
     * so it found nothing and silently failed open on every single push - a
     * guard that was installed and did nothing, which is the exact shape this
     * whole law is about.
     */
    const guard = read(GUARD_PATH);
    expect(guard, 'the guard must look in the primary clone for .env').toMatch(
      /--git-common-dir/
    );
  });

  it('the override exists and is spelled the way the docs promise', () => {
    const guard = read(GUARD_PATH);
    expect(guard).toMatch(/AGENT_MERGED_BRANCH_OK/);
    // CLAUDE.md 10.82 and .env.example both hand this to the reader; if the
    // variable is renamed they become instructions that do not work.
    expect(read('CLAUDE.md')).toMatch(/AGENT_MERGED_BRANCH_OK=1/);
    expect(read('.env.example')).toMatch(/AGENT_MERGED_BRANCH_OK=1/);
  });
});
