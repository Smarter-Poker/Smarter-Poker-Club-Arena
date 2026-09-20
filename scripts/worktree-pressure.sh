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

# THE DISK IT MEASURED WAS NOT THE DISK THE WORKTREES WERE ON (2026-09-19).
#
# This read `df -g "$HOME"` because in 2026-09-07 the worktrees were on the
# internal disk. They are not any more: AGENTS.md puts them under
# /Volumes/SmarterWork/agent-work, an APFS volume whose quota is far smaller
# than the device it sits on. On 2026-09-19 that volume reached 99.9% of its
# 274.9 GB quota with 313 MiB left, `npm ci` died with ENOSPC inside a
# pre-push gate, and this reader printed "110 GiB free" - a true statement
# about $HOME and a useless one about the disk that had actually filled.
#
# So measure the filesystems the worktrees are really on, report the tightest
# one, and name it. A free-space number with no filesystem attached is what
# let this hide: every agent read "110 GiB free" and believed it.
free_gib() {
  local wt free mount best best_fs seen
  seen=" "; best=""; best_fs=""
  # Ask df about each worktree, plus $HOME. No path-shape guessing: df knows
  # which mount a path is on, and the answer is deduped by the mount df
  # reports, so three volumes cost three comparisons no matter how many trees
  # sit on them. A few hundred df calls is milliseconds inside a hook that
  # already runs a test suite.
  while IFS= read -r wt; do
    [ -n "$wt" ] && [ -d "$wt" ] || continue
    read -r free mount <<< "$(df -g "$wt" 2>/dev/null | awk 'NR==2 { print $4, $NF }')"
    case "${free:-}" in ''|*[!0-9]*) continue ;; esac
    case "$seen" in *" ${mount:-$wt} "*) continue ;; esac
    seen="$seen${mount:-$wt} "
    if [ -z "$best" ] || [ "$free" -lt "$best" ]; then
      best="$free"; best_fs="${mount:-$wt}"
    fi
  done <<< "$( { git worktree list --porcelain 2>/dev/null \
                   | awk '/^worktree /{ print substr($0, 10) }'
                 printf '%s\n' "$HOME"; } )"
  # Printed as one line, never assigned to a global: this runs inside $( ),
  # so a variable set here would die with the subshell.
  printf '%s %s' "$best" "$best_fs"
}


tree_count() {
  git worktree list 2>/dev/null | wc -l | tr -d ' '
}

read -r FREE TIGHTEST_FS <<< "$(free_gib)"
TREES="$(tree_count)"

# "Could not tell" is its own outcome and is never reported as healthy.
if [ -z "${FREE:-}" ] || [ -z "${TREES:-}" ] || [ "${TREES:-0}" = "0" ]; then
  echo "[worktree-pressure] could not read free space or the worktree list; not judging." >&2
  exit 0
fi

if [ "$FREE" -lt "$FREE_GIB_FLOOR" ] || [ "$TREES" -gt "$TREE_CEILING" ]; then
  cat >&2 <<MSG
[worktree-pressure] ${FREE} GiB free on ${TIGHTEST_FS:-the worktree filesystem}, ${TREES} worktrees registered.
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
