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
  # 2026-09-07. This refusal was correct and useless: it named the ONE cause it
  # was not, and stayed silent about the one it was. `core.bare` had been set
  # true on the canonical clone, so every work-tree git command there failed,
  # this script refused on every run, and 224 worktrees accumulated until the
  # disk hit 100%. Say which of the two it is.
  if [ "$(git config --local --get core.bare 2>/dev/null)" = "true" ] \
     && [ -e "$(git rev-parse --git-dir 2>/dev/null)/../package.json" ]; then
    cat >&2 <<'BARE'
This clone has core.bare=true but a working tree on disk beside it, so every
git command that needs files refuses here - including this script, which is
why nothing has been pruned. Nothing is damaged; the flag is simply wrong:

    git -C "$(pwd)" config --local core.bare false

Then run this script again.
BARE
    exit 1
  fi
  echo "Run from inside the canonical clone (e.g. ~/Documents/club-arena)." >&2
  exit 1
fi
cd "$REPO_ROOT"

NOW=$(date +%s)
CUTOFF=$(( NOW - IDLE_HOURS * 3600 ))
REMOVED=0; KEPT_ACTIVE=0; KEPT_UNPUSHED=0; KEPT_DIRTY=0

git fetch -q origin || echo "warn: fetch failed; using last-known remote refs" >&2

# The ref squashed work lands on. If it cannot be resolved we must NOT fall
# through to pruning on a bad comparison, so the squash-aware path is disabled
# and every unmatched worktree takes the loud KEEP instead.
UPSTREAM_REF="origin/main"
if ! git rev-parse --verify -q "$UPSTREAM_REF" >/dev/null; then
  echo "warn: $UPSTREAM_REF is unresolvable; keeping every unmatched worktree" >&2
  UPSTREAM_REF=""
fi

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

  # 2. Is this work safely on origin?
  #
  # THE FAST PATH: HEAD reachable from a remote ref. Correct, but it only ever
  # answers "yes" for a branch that was merged with a MERGE COMMIT.
  #
  # THIS REPO SQUASH-MERGES. A squash lands the CONTENT on main under a brand
  # new SHA, and the branch's own commits are never ancestors of main, so
  # `branch -r --contains` is empty forever for work that shipped weeks ago.
  # Every one of those worktrees was therefore filed "unpushed!" and kept for
  # good. Measured 2026-09-02: of 62 worktrees this check called unpushed,
  # 54 were already upstream in full and only 8 held anything new. That is
  # the whole reason the worktree count only ever grows, and why this machine
  # reached 92% full with ~110 GB of duplicated node_modules.
  #
  # THE SLOW PATH, only when the fast one says no: `git cherry` compares
  # PATCH IDs rather than SHAs, so it recognises a squashed commit by its
  # content. It prints '-' for a commit that already has an equivalent
  # upstream and '+' for one that does not. Zero '+' lines means every commit
  # here is already on main under another SHA - safe to prune.
  #
  # This can only ever move a worktree from KEEP to PRUNE when git itself says
  # the content is upstream. A branch with even one genuinely new commit still
  # takes the loud KEEP below, and `git worktree remove` without --force
  # remains the final refusal.
  if [ -z "$(git -C "$WT" branch -r --contains HEAD 2>/dev/null | head -1)" ]; then
    if [ -z "$UPSTREAM_REF" ]; then
      echo "KEEP  (unpushed!) $WT   <- push this branch or it exists only here"
      KEPT_UNPUSHED=$((KEPT_UNPUSHED+1)); continue
    fi
    CHERRY="$(git -C "$WT" cherry "$UPSTREAM_REF" HEAD 2>/dev/null || true)"
    NEW_COMMITS="$(printf '%s' "$CHERRY" | grep -c '^+' || true)"
    NEW_COMMITS="${NEW_COMMITS:-0}"
    if ! [ "$NEW_COMMITS" -eq 0 ] 2>/dev/null; then
      echo "KEEP  (unpushed!) $WT   <- ${NEW_COMMITS} commit(s) exist only here; push this branch"
      KEPT_UNPUSHED=$((KEPT_UNPUSHED+1)); continue
    fi
    echo "SQUASHED          $WT   <- content already on ${UPSTREAM_REF} under another sha"
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
