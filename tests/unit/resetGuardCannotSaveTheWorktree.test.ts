/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE FAST-FORWARD SYNC RESET, AND WHY NO HOOK CAN RESCUE IT (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This file exists to stop a specific fix from being written a second time.
 * It was written once, on 2026-08-31, tested, found to be actively harmful,
 * and reverted. The trap is that it LOOKS correct right up until you check the
 * bytes.
 *
 * THE GAP THAT IS REAL
 *
 * `.husky/reference-transaction` has two branches:
 *   - OLD == NEW  -> a bare `git reset --hard`. Warns.
 *   - ORPHANED    -> a rewind that would strand local commits. Saves + blocks.
 *
 * A `git reset --hard origin/main` in a clone that is merely BEHIND (HEAD an
 * ancestor of origin, zero local commits) matches NEITHER: HEAD moves, so the
 * first is skipped, and `git log NEW..OLD` is empty, so the second `continue`s.
 * Tracked modifications are discarded with no warning at all.
 *
 * That is not exotic. Measured 2026-08-31, the shared clone sat 42 commits
 * behind with 0 local commits and 25 modified files - and that reset is
 * exactly what Antigravity runs on a timer to sync it.
 *
 * WHY THE OBVIOUS FIX IS WORSE THAN THE GAP
 *
 * The obvious fix - "if the tree is dirty here, `git stash create` it and warn"
 * - fails in both directions, because by the time reference-transaction fires
 * at "prepared" git has ALREADY overwritten the working tree. Probed directly
 * inside the hook during a real fast-forward reset:
 *
 *     before reset, worktree f.txt = "IMPORTANT LOCAL EDIT"
 *     PROBE worktree f.txt         = [v2]        <- origin's content already
 *     PROBE git show HEAD:f.txt    = [v1]        <- HEAD not yet moved
 *     PROBE git status --porcelain = [M  f.txt]  <- git's OWN staged change
 *
 * So:
 *   1. FALSE POSITIVE. The `M` is git's in-flight reset, not user dirt, so the
 *      warning fires on every clean sync reset - noise on a timer, which is
 *      how a real warning gets ignored.
 *   2. USELESS SNAPSHOT. `git stash create` captures the POST-reset bytes. The
 *      ref it writes looks like a rescue and contains origin's content. That is
 *      worse than no snapshot: it answers "was my work saved?" with a
 *      confident yes.
 *
 * WHAT ACTUALLY PROTECTS THE WORK
 *
 * The launchd snapshotter (scripts/install-wip-snapshot-agent.sh, every 10
 * minutes) writes real pre-reset content to refs/wip/. Verified healthy on
 * 2026-08-31: 77 snapshots across 25 repos, and the newest club-arena snapshot
 * held all 25 modified files. Untracked files are not at risk from `reset
 * --hard` at all - only `git clean -fd` removes them, and nothing in the estate
 * runs it.
 *
 * THE RULE: do not add a working-tree rescue to reference-transaction. If you
 * are about to, read the probe above first - it is the whole argument.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const HOOK = readFileSync(resolve(__dirname, '../../.husky/reference-transaction'), 'utf8');

describe('reference-transaction does not pretend to rescue the working tree', () => {
  it('never calls `git stash create` - the bytes are already gone by then', () => {
    // The one line that would re-introduce the useless-snapshot bug. The hook
    // may SAY the words in a comment; it must not run the command.
    const code = HOOK.split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/git stash create/);
  });

  it('still keeps the two branches that DO work', () => {
    const code = HOOK.split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');
    // Bare `git reset --hard`: history does not move, so it warns.
    expect(code).toContain('if [ "$OLD" = "$NEW" ]');
    // A rewind that would strand local commits: saves the COMMITS (which are
    // real objects and genuinely recoverable) and blocks.
    expect(code).toMatch(/refs\/wip\/orphan-guard/);
    expect(code).toMatch(/exit 1/);
  });

  it('documents the fast-forward gap so it is not rediscovered as a surprise', () => {
    // Prose, deliberately: the gap cannot be closed here, so the only thing
    // that helps the next reader is knowing it was measured and why.
    expect(HOOK.toLowerCase()).toMatch(/untracked files are untouched/);
  });
});

describe('the mechanism that actually protects a dirty shared clone', () => {
  it('the 10-minute snapshotter is installed by a tracked script', () => {
    // If this file disappears, the ONLY real protection for tracked
    // modifications in the shared clone has gone with it.
    const installer = readFileSync(
      resolve(__dirname, '../../scripts/install-wip-snapshot-agent.sh'),
      'utf8'
    );
    expect(installer).toMatch(/refs\/wip/);
    expect(installer.length).toBeGreaterThan(200);
  });

  it('the snapshotter walks agent trees, not just one clone', () => {
    const walker = readFileSync(
      resolve(__dirname, '../../scripts/agent-trees-snapshot.sh'),
      'utf8'
    );
    expect(walker).toMatch(/refs\/wip/);
    // It must keep saying that untracked files are its blind spot, because a
    // reader who assumes otherwise will trust it with work it cannot hold.
    expect(walker).toMatch(/git clean/);
  });
});
