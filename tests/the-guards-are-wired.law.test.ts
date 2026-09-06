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
    // No token anywhere -> exit 0
    expect(guard).toMatch(/\[ -z "\$CANDIDATES" \] && exit 0/);
    // Every candidate rejected, or no network -> exit 0
    expect(guard).toMatch(/if \[ -z "\$RESP" \]; then[\s\S]*?exit 0/);
    // Nothing definite to say -> exit 0
    expect(guard).toMatch(/\[ -z "\$VERDICT" \] && exit 0/);
    // And the only exit 1 is the deliberate refusal at the very end. This is
    // the property, not the wording: one refusal, everything else permissive.
    const exits = guard.match(/^exit 1$/gm) || [];
    expect(exits.length, 'the guard should refuse in exactly one place').toBe(1);
  });

  it('it TRIES each candidate token instead of trusting the first it finds', () => {
    /**
     * The second way this guard was inert (2026-09-06, within an hour of the
     * first). It stopped at the first key it could read. The World Hub's .env
     * yields GITHUB_PAT_FINE_GRAINED, that PAT has expired and answers "Bad
     * credentials", and the working GITHUB_TOKEN sits in the sibling clone
     * which was therefore never reached. A guard that stops at the first
     * plausible key is inert whenever the first key is stale - and it lets a
     * real lost-commit incident through while reading as installed.
     */
    const guard = read(GUARD_PATH);
    expect(guard, 'candidates must be collected, not short-circuited').toMatch(/CANDIDATES/);
    expect(guard, 'each candidate must be tried against the API').toMatch(
      /for TOKEN in \$CANDIDATES/
    );
    expect(guard, 'a rejected token must fall through to the next').toMatch(/Bad credentials/);
  });

  it('an auth failure is LOUD, even though it still allows the push', () => {
    // Failing open is correct and pinned above. But silence about it recreates
    // the exact state this law is named for: installed, running, doing nothing.
    const guard = read(GUARD_PATH);
    expect(guard).toMatch(/WARNING: guard-merged-branch could not authenticate/);
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
    expect(guard, 'the guard must look in the primary clone for .env').toMatch(/--git-common-dir/);
    // And in the sibling estate repo, because one working token serves both.
    expect(guard, 'the sibling clone is the other place a token lives').toMatch(
      /club-arena\/\.env/
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

describe('LAW - the test gate can never look at an empty diff', () => {
  /**
   * FOUND 2026-09-06, and it had been true for as long as the hook has had a
   * test gate.
   *
   * The new-branch arm read `git diff --name-only "$LOCAL_SHA"` - the WORKING
   * TREE against that commit. A clean tree at push time returns NOTHING, so
   * `FILES` was empty, `CHANGED_SRC` and `CHANGED_TESTS` were empty, and the
   * vitest gate below them was skipped in silence. Every house rule still
   * printed OK, so the push read as fully checked while the one guard
   * CLAUDE.md rule 8 calls the seatbelt had not run at all.
   *
   * Measured: 0 files that way against 7 the right way, on a push whose diff
   * CONTAINED the test that CI then failed on.
   *
   * And it is the path every agent takes: 10.82 requires a new branch off main
   * for every follow-up commit, so the rule that stops commits vanishing sends
   * all of them through the one arm where the gate is blind.
   */
  const hook = read(HOOK_PATH);

  it('never diffs the working tree against the commit being pushed', () => {
    /* `git diff --name-only <sha>` with no second ref is the bug. Two refs, or
       a range, is a real answer about what the push contains. */
    expect(hook, 'the new-branch arm is comparing against the working tree again').not.toMatch(
      /git diff --name-only "\$LOCAL_SHA"\s*\)/
    );
  });

  it('the new-branch arm resolves a merge base, like the remote-tip arm already did', () => {
    const arm = hook.slice(
      hook.indexOf('if [ "$REMOTE_SHA" = "0000'),
      hook.indexOf('# A FILE THAT IS IDENTICAL TO origin/main')
    );
    expect(arm, 'the new-branch arm must exist').not.toBe('');
    expect(arm, 'no merge-base in the new-branch arm').toMatch(/merge-base "\$LOCAL_SHA"/);
    expect(arm, 'it must diff two refs').toMatch(/git diff --name-only "\$BASE" "\$LOCAL_SHA"/);
    /* "I could not tell" is never "nothing changed" (10.86 rule 1): with no
       common base it checks the whole tree instead of an empty list. */
    expect(arm, 'no whole-tree fallback').toMatch(/git ls-files/);
  });
});
