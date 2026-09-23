/**
 * CLAUDE.md 10.83: a check that nobody can see is not a check.
 * CLAUDE.md 10.86 rule 3: a guard must have a reader, and you must name them.
 * CLAUDE.md 10.87 rule 1: the freshness guard is ADVISORY and must stay so.
 *
 * WHY THIS EXISTS (2026-09-21)
 *
 * `scripts/check-checkout-freshness.sh` was written on 2026-09-12 to stop the
 * canonical clone rotting. It worked perfectly. It reported nothing to anybody
 * for nine days, and the clone rotted again anyway - 258 commits and four days
 * behind, serving the SUPERSEDED September 16 owner instruction to every agent
 * that loaded `CLAUDE.md` out of it.
 *
 * The reason is the whole lesson: `.husky/pre-push` was its ONLY caller in the
 * repository, no workflow referenced it, and `scripts/guard-shared-clone.sh`
 * forbids pushing from `~/Documents/club-arena`. The one tree that rots is the
 * one tree the check could never run in. Its sibling,
 * `scripts/check-unpushed-work.sh`, had been wired into
 * `scripts/agent-workspace.sh` since 2026-08-23 for exactly this reason, with
 * the comment "an agent claiming a workspace is the most frequent moment
 * anybody looks at this machine". The freshness guard never got the same wire.
 *
 * So this law pins the READER, not more teeth. Giving the guard the power to
 * refuse a push would be the other failure: 10.87 rule 1 says a freshness
 * guard that can wedge every push in the estate is worse than the staleness it
 * reports.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const FRESHNESS = 'scripts/check-checkout-freshness.sh';

describe('the checkout freshness guard has a reader', () => {
  it('agent-workspace.sh runs it, so the canonical clone is measured', () => {
    const src = read('scripts/agent-workspace.sh');
    expect(
      src.includes(FRESHNESS),
      'agent-workspace.sh is the reader: it is the one command every agent ' +
        'runs on this machine, and the canonical clone never pushes, so the ' +
        'pre-push hook alone can never see it.'
    ).toBe(true);
  });

  it('it is advisory in BOTH readers, and can wedge neither', () => {
    // 10.87 rule 1. The window is bounded by the call itself, not a byte count.
    for (const file of ['scripts/agent-workspace.sh', '.husky/pre-push']) {
      const src = read(file);
      const start = src.indexOf(FRESHNESS);
      expect(start, `${file} does not call the freshness check`).toBeGreaterThan(-1);
      const line = src.slice(start, src.indexOf('\n', start));
      expect(line, `${file} must not let the freshness check fail the run`).toContain('|| true');
    }
  });

  it('the guard stays READ-ONLY: it may never pull, reset or delete', () => {
    // A reader that repairs is how a measurement becomes an outage. The
    // 2026-09-12 header promises it "never pulls, resets, prunes, checks out,
    // or deletes anything"; this is that promise, enforced.
    //
    // Only EXECUTABLE lines count. The script explains the `pull --ff-only`
    // jam in its header and prints "Never reset over work you have not read"
    // as advice, and a substring scan flags all three. A guard that cannot
    // tell an invocation from the prose describing it is the false positive
    // CLAUDE.md 10.86 is about, so the verb has to sit in COMMAND position.
    const lines = read(FRESHNESS)
      .split('\n')
      .filter((l) => !/^\s*#/.test(l));
    const forbidden = [
      /git\s+pull\b/,
      /git\s+reset\s+--hard\b/,
      /git\s+checkout\b/,
      /git\s+worktree\s+remove\b/,
      /git\s+stash\s+(?:clear|drop)\b/,
      /git\s+branch\s+-D\b/,
    ];
    for (const line of lines) {
      for (const verb of forbidden) {
        const at = new RegExp(`(?:^|[;&|(]|\\$\\()\\s*${verb.source}`);
        expect(at.test(line), `${FRESHNESS} must not run: ${line.trim()}`).toBe(false);
      }
    }
  });

  it('"could not tell" keeps its own exit code, separate from green', () => {
    // 10.86 rule 1: a freshness check that reports "fresh" when it could not
    // reach GitHub is the bug it was written to prevent.
    const src = read(FRESHNESS);
    expect(src).toMatch(/exit\s+3/);
  });
});
