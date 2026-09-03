/**
 * THE PRUNER MUST RECOGNISE A SQUASH-MERGED BRANCH
 * ═══════════════════════════════════════════════════════════════════════════
 * `scripts/prune-stale-worktrees.sh` decided "is this work safely on origin?"
 * with `git branch -r --contains HEAD`. That asks whether HEAD is an ANCESTOR
 * of a remote ref, which is only ever true for a branch merged with a merge
 * commit.
 *
 * This repository squash-merges. A squash puts the CONTENT on main under a new
 * SHA and the branch's own commits never become ancestors of anything, so the
 * check answered "not on origin" forever for work that shipped weeks ago.
 * Every such worktree was kept, permanently.
 *
 * Measured 2026-09-02: of 62 worktrees the check called "unpushed!", 54 were
 * already upstream in full and 8 held anything new. The machine was at 92%
 * full with ~110 GB of duplicated node_modules across 355 trees, and
 * `git worktree list` had started to hang.
 *
 * The fix asks `git cherry`, which compares PATCH IDs and so recognises a
 * squashed commit by its content. These pins are about the SHAPE of that
 * check, because the dangerous direction is a change that prunes a worktree
 * holding the only copy of somebody's work.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = readFileSync(join(process.cwd(), 'scripts/prune-stale-worktrees.sh'), 'utf8');

describe('prune-stale-worktrees is squash-merge aware', () => {
  it('consults git cherry, not only ancestry', () => {
    expect(SCRIPT).toMatch(/git -C "\$WT" cherry/);
  });

  it('still keeps a worktree that has even one commit of its own', () => {
    // The '+' lines are commits with no equivalent upstream. If any exist the
    // script must take the loud KEEP branch and never reach the prune.
    expect(SCRIPT).toMatch(/grep -c '\^\+'/);
    expect(SCRIPT).toMatch(/KEEP {2}\(unpushed!\)/);
  });

  it('fails CLOSED when the upstream ref cannot be resolved', () => {
    // A pruner that cannot see origin/main must keep everything, never prune
    // on the strength of a comparison it could not make.
    expect(SCRIPT).toMatch(/UPSTREAM_REF=""/);
    expect(SCRIPT).toMatch(/keeping every unmatched worktree/);
  });

  it('never force-removes a worktree', () => {
    // `git worktree remove` without --force refuses a dirty tree. That refusal
    // is the last thing standing between a bug here and somebody's work.
    expect(SCRIPT).not.toMatch(/worktree remove\s+--force/);
    expect(SCRIPT).toMatch(/git worktree remove "\$WT"/);
  });

  it('never deletes anything with rm', () => {
    expect(SCRIPT).not.toMatch(/\brm\s+-[rf]/);
  });

  it('keeps the three original safety gates', () => {
    expect(SCRIPT).toMatch(/status --porcelain/); // dirty
    expect(SCRIPT).toMatch(/IDLE_HOURS/); // idle
    expect(SCRIPT).toMatch(/branch -r --contains HEAD/); // fast-path ancestry
  });
});
