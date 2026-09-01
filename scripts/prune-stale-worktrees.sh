#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# prune-stale-worktrees.sh — remove agent worktrees whose work is safely on
# origin, so stale trees stop re-fighting settled wars.
#
# Added 2026-09-01 (cost + regression audit). This machine had 381 worktrees
# of Club Arena, median ~800 commits behind main. Stale trees carry stale
# CLAUDE.md laws, and agents reading them re-revert current work — that is
# exactly how the hamburger-menu revert war (#2321/#2401/#2429/#2432)
# sustained itself for two days. They also each hold a full node_modules.
#
# A worktree is removed ONLY when ALL of these hold:
#   1. `git status --porcelain` is empty (nothing uncommitted), and
#   2. its HEAD is reachable from some remote ref (the branch was pushed —
#      the commits live on origin whatever happens to this directory), and
#   3. its last commit is older than IDLE_HOURS (default 72).
#
# Anything else is REPORTED, never touched, and `git worktree remove` without
# --force is the final safety: it refuses a dirty tree even if the checks
# above were wrong. Nothing is ever deleted with rm.
#
# Usage:
#   bash scripts/prune-stale-worktrees.sh --dry-run     # report only
#   bash scripts/prune-stale-worktrees.sh               # prune
#   IDLE_HOURS=168 bash scripts/prune-stale-worktrees.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

IDLE_HOURS="${IDLE_HOURS:-72}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  echo "Run from inside the canonical clone (e.g. ~/Documents/club-arena)." >&2
  exit 1
fi
cd "$REPO_ROOT"

NOW=$(date +%s)
CUTOFF=$(( NOW - IDLE_HOURS * 3600 ))
REMOVED=0; KEPT_ACTIVE=0; KEPT_UNPUSHED=0; KEPT_DIRTY=0

git fetch -q origin || echo "warn: fetch failed; using last-known remote refs" >&2

# Every linked worktree (skips the main clone itself, which has no "worktree"
# prefix ambiguity: the first block is the main clone).
MAIN_WT="$(git rev-parse --path-format=absolute --git-common-dir | sed 's|/\.git$||')"
while read -r WT; do
  [ "$WT" = "$MAIN_WT" ] && continue
  [ -d "$WT" ] || continue

  # 1. Uncommitted work: keep, and say so.
  if [ -n "$(git -C "$WT" status --porcelain 2>/dev/null | head -1)" ]; then
    echo "KEEP  (dirty)     $WT"
    KEPT_DIRTY=$((KEPT_DIRTY+1)); continue
  fi

  # 3. Recent work: keep. (Checked before the remote test — cheap first.)
  LAST=$(git -C "$WT" log -1 --format=%ct 2>/dev/null || echo 0)
  if [ "$LAST" -gt "$CUTOFF" ]; then
    echo "KEEP  (active)    $WT"
    KEPT_ACTIVE=$((KEPT_ACTIVE+1)); continue
  fi

  # 2. HEAD not on any remote ref: the commits exist only here. Keep, loudly.
  if [ -z "$(git -C "$WT" branch -r --contains HEAD 2>/dev/null | head -1)" ]; then
    echo "KEEP  (unpushed!) $WT   <- push this branch or it exists only here"
    KEPT_UNPUSHED=$((KEPT_UNPUSHED+1)); continue
  fi

  if [ "$DRY_RUN" = "1" ]; then
    echo "PRUNE (dry-run)   $WT"
  else
    if git worktree remove "$WT" 2>/dev/null; then
      echo "PRUNED            $WT"
    else
      echo "KEEP  (refused)   $WT   <- git refused; inspect by hand"
    fi
  fi
  REMOVED=$((REMOVED+1))
done < <(git worktree list --porcelain | awk '/^worktree /{print $2}')

git worktree prune
echo "---"
echo "idle>${IDLE_HOURS}h+pushed+clean: ${REMOVED} pruned$( [ "$DRY_RUN" = "1" ] && echo ' (dry run)') | kept: ${KEPT_ACTIVE} active, ${KEPT_DIRTY} dirty, ${KEPT_UNPUSHED} unpushed"
