#!/usr/bin/env bash
# WHAT IS ABOUT TO STOP EVERY AGENT ON THIS MACHINE.
#
# 2026-09-07: the Mac reached 100% of a 926 GiB disk with 224 registered
# worktrees. The symptom was not "disk full" - it was vitest dying with
# "No space left on device" mid-run, git behaving strangely, and a push hook
# failing for a reason that had nothing to do with the diff. The cause had been
# building for days behind a prune that could not run (see the core.bare note
# in prune-stale-worktrees.sh).
#
# Nothing in CI can see this: the worktrees are on Dan's Mac and the runners are
# not. So the reader has to be the person pushing, which is every agent, on
# every push. This WARNS and never blocks - a full disk is bad, a hook that
# refuses to let you save your work because the disk is nearly full is worse.
set -uo pipefail

FREE_GIB_FLOOR="${WORKTREE_FREE_GIB_FLOOR:-25}"
TREE_CEILING="${WORKTREE_COUNT_CEILING:-150}"

free_gib() {
  df -g "$HOME" 2>/dev/null | awk 'NR==2 {print $4}'
}
tree_count() {
  git worktree list 2>/dev/null | wc -l | tr -d ' '
}

FREE="$(free_gib)"
TREES="$(tree_count)"

# "Could not tell" is its own outcome and is never reported as healthy.
if [ -z "${FREE:-}" ] || [ -z "${TREES:-}" ] || [ "${TREES:-0}" = "0" ]; then
  echo "[worktree-pressure] could not read free space or the worktree list; not judging." >&2
  exit 0
fi

if [ "$FREE" -lt "$FREE_GIB_FLOOR" ] || [ "$TREES" -gt "$TREE_CEILING" ]; then
  cat >&2 <<MSG
[worktree-pressure] ${FREE} GiB free, ${TREES} worktrees registered.
  Floor is ${FREE_GIB_FLOOR} GiB, ceiling is ${TREE_CEILING} trees. A full disk
  does not announce itself: it arrives as a test runner that cannot write a
  temp file, or a git command that fails for no reason you can see.

    bash scripts/prune-stale-worktrees.sh --dry-run   # what would go
    bash scripts/prune-stale-worktrees.sh             # clean, pushed, idle 72h

  Trees held as (dirty) or (unpushed!) are somebody's unsaved work and are
  never removed. Push them, or say why they are staying.
MSG
fi
exit 0
