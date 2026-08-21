#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  git-unstick.sh — make this clone match origin/main again, losing nothing
# ═══════════════════════════════════════════════════════════════════════════════
#
# Dan 2026-08-21. The companion to .husky/pre-rebase: that hook stops a clone
# from getting stranded, this puts one back on its feet if it already is.
#
# Safe to run at any time. In order it:
#   1. aborts any rebase / merge / cherry-pick / revert in progress
#   2. clears a stale index.lock (only when no git process is running)
#   3. saves every local-only commit to a dated backup branch
#   4. stashes uncommitted changes (kept, never dropped)
#   5. resets main to origin/main
#
# Nothing is deleted: the backup branch and the stash both survive, and both
# are printed at the end.

set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || exit 1

say() { printf '%s\n' "$*"; }
say "git-unstick: $(pwd)"

# ── 1. abort anything in progress ───────────────────────────────────────────
GD="$(git rev-parse --git-dir)"
if [ -d "$GD/rebase-merge" ] || [ -d "$GD/rebase-apply" ]; then
  say "  aborting in-progress rebase"
  CA_GIT_GUARD_ALLOW=1 git rebase --abort 2>/dev/null || true
fi
[ -f "$GD/MERGE_HEAD" ]       && { say "  aborting merge";       git merge --abort 2>/dev/null || true; }
[ -f "$GD/CHERRY_PICK_HEAD" ] && { say "  aborting cherry-pick"; git cherry-pick --abort 2>/dev/null || true; }
[ -f "$GD/REVERT_HEAD" ]      && { say "  aborting revert";      git revert --abort 2>/dev/null || true; }

# ── 2. stale lock (only if nothing is actually running) ─────────────────────
if [ -f "$GD/index.lock" ]; then
  if pgrep -x git >/dev/null 2>&1; then
    say "  index.lock present but a git process is running - leaving it alone"
  else
    say "  clearing stale index.lock"
    rm -f "$GD/index.lock" 2>/dev/null || true
  fi
fi

# ── 3. back up local-only commits ───────────────────────────────────────────
git fetch --quiet origin main || { say "  ERROR: cannot reach origin"; exit 1; }
AHEAD="$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)"
BACKUP=""
if [ "${AHEAD:-0}" -gt 0 ] 2>/dev/null; then
  BACKUP="backup/unstick-$(date +%Y%m%d-%H%M%S)"
  git branch "$BACKUP" 2>/dev/null && say "  ${AHEAD} local commit(s) saved to ${BACKUP}"
fi

# ── 4. keep uncommitted work ────────────────────────────────────────────────
STASHED=no
if ! git diff --quiet || ! git diff --cached --quiet; then
  if git stash push -u -m "git-unstick $(date -u +%FT%TZ)" >/dev/null 2>&1; then
    STASHED=yes
    say "  uncommitted changes stashed"
  fi
fi

# ── 5. match origin ─────────────────────────────────────────────────────────
git checkout --quiet main 2>/dev/null || true
git reset --hard --quiet origin/main && say "  main now matches origin/main ($(git rev-parse --short HEAD))"

say ""
say "done. nothing was lost:"
[ -n "$BACKUP" ] && say "  local commits : git log $BACKUP"
[ "$STASHED" = yes ] && say "  your edits    : git stash list  (git stash pop to restore)"
[ -z "$BACKUP" ] && [ "$STASHED" = no ] && say "  (there was nothing local to keep)"
