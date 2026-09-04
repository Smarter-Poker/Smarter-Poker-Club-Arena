/**
 * A law read in a stale worktree must not be enforced from one.
 *
 * CLAUDE.md 10.8.1 says it already: "Laws are read from `origin/main`, never
 * from your local tree." Nothing checked. Measured on this machine on
 * 2026-09-04, AFTER pruning 51 worktrees:
 *
 *   160 Club Arena worktrees
 *   154 whose CLAUDE.md differs from origin/main
 *   102 still carrying `bash scripts/sync-club-arena.sh` or the heading
 *       "The Only Deploy Path"
 *
 * Those trees are days old, not months. Doctrine moved faster than they did,
 * and `prune-stale-worktrees.sh` cannot help: it removes only what is clean,
 * pushed and idle for 72 hours, and it is right to.
 *
 * `scripts/ci/check-doctrine-freshness.mjs` closes it at the moment it
 * matters - the push. This test pins the three properties that make it safe
 * to have in every agent's hook, because getting any of them wrong turns a
 * useful advisor into an estate-wide outage:
 *
 *   1. it is WIRED (a guard nobody calls is the shape this repo keeps
 *      shipping - sixteen invariants once printed "all passed" and ran none);
 *   2. it FAILS OPEN, so it cannot wedge every push;
 *   3. it only calls an instruction retired when origin/main agrees it is
 *      retired, so the guard cannot become its own stale law.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('doctrine is read from origin/main', () => {
  it('the pre-push hook calls the freshness check', () => {
    const hook = read('.husky/pre-push');
    expect(hook).toContain('scripts/ci/check-doctrine-freshness.mjs');
    // Sets FAIL=1 rather than exiting, so it reports alongside every other
    // guard instead of hiding the ones after it.
    const block = hook.slice(hook.indexOf('check-doctrine-freshness.mjs'));
    expect(block.slice(0, 400)).toContain('FAIL=1');
  });

  it('it fails open, so it cannot wedge every push in the estate', () => {
    const src = read('scripts/ci/check-doctrine-freshness.mjs');
    expect(src).toMatch(/catch \(err\)[\s\S]{0,200}code = 0/);
    // An unreadable origin/main (offline, fresh clone) is a skip, not a block.
    expect(src).toMatch(/origin\/main:CLAUDE\.md[\s\S]{0,400}return 0/);
  });

  it('an instruction is only "retired" when origin/main agrees it is', () => {
    const src = read('scripts/ci/check-doctrine-freshness.mjs');
    // The guard compares against the canonical file before reporting. Without
    // this, the guard itself becomes a stale law the day doctrine changes back.
    expect(src).toMatch(/rule\.pattern\.test\(canonical\)/);
  });

  it('it blocks a doctrine-changing push and only warns otherwise', () => {
    const src = read('scripts/ci/check-doctrine-freshness.mjs');
    expect(src).toContain('DOCTRINE_PATHS');
    // Substring, not regex: the source stores these AS regex literals, so
    // `docs\/LAWS\.md` is the text on the page and matching it with a regex
    // that means "docs/LAWS.md" finds nothing.
    for (const p of ['CLAUDE', 'LAWS', 'law', 'workflows', 'agent', 'HANDOFF', 'husky']) {
      const paths = src.slice(src.indexOf('DOCTRINE_PATHS'), src.indexOf('function main'));
      expect(paths, `DOCTRINE_PATHS must cover ${p}`).toContain(p);
    }
    expect(src).toMatch(/blocking\s*=\s*touchingDoctrine\.length > 0/);
  });

  it('this repo’s own CLAUDE.md carries none of the retired instructions', () => {
    const claude = read('CLAUDE.md');
    expect(claude).not.toMatch(/bash\s+scripts\/sync-club-arena\.sh/);
    expect(claude).not.toMatch(/The Only Deploy Path/i);
    expect(claude).not.toMatch(/build-for-world-hub/);
  });
});
