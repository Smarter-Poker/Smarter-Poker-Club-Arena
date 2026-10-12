#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# agent-tree-janitor.sh — keep the agent worktree estate from filling this Mac.
#
# 2026-09-29: 659 registered worktrees, 490 of them on the boot disk, which
# reached 100% (116 MiB free) and broke every agent on the machine: npm ci,
# vitest and git all failed with ENOSPC, and the failures looked like bugs in
# whatever the agent was doing. scripts/prune-stale-worktrees.sh already
# removes trees that are clean, pushed and idle - but almost no tree qualifies,
# because agents leave uncommitted files behind. What actually fills the disk
# is node_modules: ~400 MiB per tree, regenerable in a minute by npm ci.
#
# So this sweeps in tiers, safest first, and never deletes anything that cannot
# be regenerated or that is not already saved somewhere else:
#
#   TIER 1  build junk in idle trees: node_modules, dist*, coverage,
#           playwright-report, test-results, .vite caches. Regenerable.
#   TIER 2  the repo's own pruner: remove trees that are clean, pushed and
#           idle (it refuses a dirty tree; `git worktree remove` is the guard).
#   TIER 3  trees abandoned for ARCHIVE_DAYS with work still in them: the
#           branch commits go into a git bundle, the uncommitted diff into a
#           patch and untracked files into a tar, all under
#           /Volumes/SmarterArchives/agent-evidence/abandoned-trees/<name>/,
#           and only then is the tree removed.
#
# "Idle" means no tracked file in the tree has changed for IDLE_DAYS, and the
# tree is not one this run was told to keep (KEEP_PATTERN).
#
# Usage:
#   bash scripts/agent-tree-janitor.sh                  # report only (default)
#   bash scripts/agent-tree-janitor.sh --apply          # tiers 1 and 2
#   bash scripts/agent-tree-janitor.sh --apply --archive  # tiers 1, 2 and 3
#   IDLE_DAYS=3 ARCHIVE_DAYS=21 KEEP_PATTERN='my-tree' bash scripts/agent-tree-janitor.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

CLONE="${CA_CLONE:-$HOME/Documents/club-arena}"
IDLE_DAYS="${IDLE_DAYS:-3}"
ARCHIVE_DAYS="${ARCHIVE_DAYS:-21}"
ARCHIVE_ROOT="${ARCHIVE_ROOT:-/Volumes/SmarterArchives/agent-evidence/abandoned-trees}"
KEEP_PATTERN="${KEEP_PATTERN:-}"
APPLY=0; ARCHIVE=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --archive) ARCHIVE=1 ;;
    --help|-h) sed -n '2,36p' "$0"; exit 0 ;;
  esac
done

cd "$CLONE" || { echo "no clone at $CLONE" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
human() { awk -v b="$1" 'BEGIN{ split("B KiB MiB GiB TiB",u," "); i=1; while(b>=1024 && i<5){b/=1024;i++} printf "%.1f %s", b, u[i] }'; }

FREED=0; T1=0; T2=0; T3=0; KEPT=0
NOW=$(date +%s)
IDLE_CUTOFF=$(( NOW - IDLE_DAYS * 86400 ))
ARCHIVE_CUTOFF=$(( NOW - ARCHIVE_DAYS * 86400 ))

say "ca-tree-janitor  $(date '+%Y-%m-%d %H:%M')  apply=$APPLY archive=$ARCHIVE idle=${IDLE_DAYS}d archive_after=${ARCHIVE_DAYS}d"
say "clone: $CLONE"

# Registered worktrees, minus the clone itself and anything locked.
# bash 3.2 on macOS has no mapfile, and a pipe would put the loop in a subshell
# where every counter it increments dies with it. A temp list keeps it here.
TREE_LIST=$(mktemp -t catrees)
trap 'rm -f "$TREE_LIST"' EXIT
git worktree list --porcelain | awk '/^worktree /{p=substr($0,10)} /^locked/{p=""} /^$/{ if (p != "") print p; p="" } END{ if (p != "") print p }' > "$TREE_LIST"

while IFS= read -r T; do
  [ "$T" = "$CLONE" ] && continue
  [ -d "$T" ] || continue
  if [ -n "$KEEP_PATTERN" ] && printf '%s' "$T" | grep -Eq "$KEEP_PATTERN"; then
    KEPT=$((KEPT+1)); continue
  fi
  # Newest tracked-ish file, ignoring build junk and .git bookkeeping.
  NEWEST=$(find "$T" -maxdepth 4 -type f \
      -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist*/*' \
      -not -path '*/coverage/*' -not -path '*/test-results/*' -not -path '*/playwright-report/*' \
      -newermt "@$IDLE_CUTOFF" -print -quit 2>/dev/null)
  if [ -n "$NEWEST" ]; then
    KEPT=$((KEPT+1))
    continue   # somebody is working in there right now
  fi

  # TIER 1 — regenerable weight.
  for JUNK in node_modules dist dist-native dist-diamond coverage playwright-report test-results .vite; do
    [ -e "$T/$JUNK" ] || continue
    SZ=$(du -sk "$T/$JUNK" 2>/dev/null | cut -f1); SZ=$(( ${SZ:-0} * 1024 ))
    if [ "$APPLY" = 1 ]; then rm -rf "$T/$JUNK" && { FREED=$((FREED+SZ)); T1=$((T1+1)); say "  freed  $(human $SZ)  $T/$JUNK"; }
    else FREED=$((FREED+SZ)); T1=$((T1+1)); say "  would free  $(human $SZ)  $T/$JUNK"; fi
  done

  # TIER 3 — abandoned with work in it: archive, then remove.
  if [ "$ARCHIVE" = 1 ]; then
    OLDEST_OK=$(find "$T" -maxdepth 4 -type f -not -path '*/node_modules/*' -not -path '*/.git/*' \
        -newermt "@$ARCHIVE_CUTOFF" -print -quit 2>/dev/null)
    if [ -z "$OLDEST_OK" ]; then
      DIRTY=$(git -C "$T" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
      BRANCH=$(git -C "$T" rev-parse --abbrev-ref HEAD 2>/dev/null)
      AHEAD=$(git -C "$T" rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
      # A local .env is ignored, so it is not in the untracked tar and must
      # never be copied into a shared archive either. Nearly every tree holds
      # one and nearly every one is a byte-for-byte copy of the canonical
      # clone's - regenerable, so removing the tree loses nothing. A tree whose
      # .env DIFFERS is somebody's own configuration: it is reported and left
      # exactly where it is. (2026-09-29: 210 of 442 trees were kept by this.)
      ENV_DIFFERS=0
      for E in "$T"/.env*; do
        [ -f "$E" ] || continue
        BASE=$(basename "$E")
        if [ -f "$CLONE/$BASE" ] && cmp -s "$E" "$CLONE/$BASE"; then continue; fi
        ENV_DIFFERS=1; break
      done
      if [ "$ENV_DIFFERS" = 1 ]; then
        say "  KEEP (its own local $BASE)  $T"
        continue
      fi
      if [ "${DIRTY:-0}" != "0" ] || [ "${AHEAD:-0}" != "0" ]; then
        NAME=$(basename "$T"); DEST="$ARCHIVE_ROOT/$(date +%Y%m%d)-$NAME"
        if [ "$APPLY" = 1 ]; then
          mkdir -p "$DEST"
          git -C "$T" status --porcelain > "$DEST/status.txt" 2>/dev/null
          git -C "$T" diff HEAD > "$DEST/uncommitted.patch" 2>/dev/null
          git -C "$T" ls-files --others --exclude-standard -z 2>/dev/null \
            | tar -C "$T" --null -T - -czf "$DEST/untracked.tgz" 2>/dev/null
          [ "${AHEAD:-0}" != "0" ] && git -C "$T" bundle create "$DEST/branch.bundle" origin/main.."$BRANCH" >/dev/null 2>&1
          printf 'tree=%s\nbranch=%s\nahead=%s\ndirty=%s\narchived=%s\n' "$T" "$BRANCH" "$AHEAD" "$DIRTY" "$(date)" > "$DEST/README.txt"
          if git worktree remove --force "$T" 2>/dev/null; then
            T3=$((T3+1)); say "  archived+removed  $T  -> $DEST"
          else
            say "  ARCHIVE KEPT (remove refused)  $T"
          fi
        else
          T3=$((T3+1)); say "  would archive+remove  $T  (dirty=$DIRTY ahead=$AHEAD)"
        fi
        continue
      fi
    fi
  fi
done < "$TREE_LIST"

# TIER 2 — the repo's own pruner: clean, pushed and idle trees only.
if [ "$APPLY" = 1 ]; then
  say "-- prune-stale-worktrees.sh"
  IDLE_HOURS=$(( IDLE_DAYS * 24 )) bash "$CLONE/scripts/prune-stale-worktrees.sh" 2>&1 | grep -E "^(PRUNE|SQUASHED|Removed|removed)" | sed 's/^/  /'
  T2=$(git worktree list | wc -l | tr -d ' ')
  git worktree prune
else
  say "-- prune-stale-worktrees.sh --dry-run"
  IDLE_HOURS=$(( IDLE_DAYS * 24 )) bash "$CLONE/scripts/prune-stale-worktrees.sh" --dry-run 2>&1 | grep -cE "^PRUNE" | sed 's/^/  prunable trees: /'
fi

say "-- summary"
say "  build folders swept: $T1   freed: $(human $FREED)"
say "  trees archived+removed: $T3   trees left registered: $(git worktree list | wc -l | tr -d ' ')   busy trees kept: $KEPT"
df -g "$HOME" /Volumes/SmarterWork 2>/dev/null | awk 'NR==1 || /\//{printf "  %s\n", $0}'
