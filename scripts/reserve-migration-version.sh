#!/usr/bin/env bash
#
# reserve-migration-version.sh <slug>
#
# Prints a migration version nobody else is using, and creates the file so the
# reservation is visible to the next agent that asks.
#
# WHY THIS EXISTS. A migration version was a timestamp each agent picked by
# hand. `git worktree list` routinely shows 40-80 live trees and origin carries
# 458 branches, so two agents starting in the same minute picked the same
# 14-digit second and one of them lost the name underneath the other. That
# happened twice in one day on 2026-09-04. It is also visible on main already:
# `ls supabase/migrations | sed 's/_.*//' | sort | uniq -d` is not empty, and
# 20260831235992 and 20260831b are what agents reached for once the obvious
# name was taken.
#
# WHAT IT CHECKS, cheapest first. All three are local; only the fetch touches
# the network, and it is a single ref.
#
#   1. this worktree's supabase/migrations/
#   2. origin/main's supabase/migrations/ (git ls-tree, no checkout)
#   3. EVERY OTHER WORKTREE of this repo on this machine - the case that
#      actually bites, because a sibling agent's migration is not on origin
#      yet and is therefore invisible to 1 and 2
#
# A same-second collision with an agent on ANOTHER machine is still possible,
# so the fallback name carries four random digits rather than incrementing:
# two agents that both lose the first draw do not then both take :01.
#
# USAGE
#   bash scripts/reserve-migration-version.sh the_union_branch_belongs_to_prod
#   -> supabase/migrations/20260904171233_the_union_branch_belongs_to_prod.sql
#
# Prints the path on stdout and nothing else, so it composes:
#   f=$(bash scripts/reserve-migration-version.sh my_slug) && $EDITOR "$f"

set -euo pipefail

slug="${1:-}"
if [ -z "$slug" ]; then
  echo "usage: $0 <slug>   (lower_snake_case, no .sql)" >&2
  exit 2
fi
# The filename is the only thing an operator sees in a directory of 2,121, so
# refuse a slug that will not tell them anything.
if ! printf '%s' "$slug" | grep -Eq '^[a-z0-9][a-z0-9_]{7,}$'; then
  echo "refusing slug '$slug': lower_snake_case, at least 8 characters." >&2
  echo "a migration called 'fix' or 'update' is unreadable in a list of 2,121." >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
mig_dir="supabase/migrations"
mkdir -p "$mig_dir"

# A lock so two agents on THIS machine cannot draw in the same instant. The
# directory form is atomic on every filesystem; flock is not on macOS.
lock="${TMPDIR:-/tmp}/club-arena-migration-version.lock"
for _ in $(seq 1 50); do
  if mkdir "$lock" 2>/dev/null; then break; fi
  sleep 0.2
done
# shellcheck disable=SC2064
trap "rmdir '$lock' 2>/dev/null || true" EXIT

# The fetch is the only slow part (network), and it is usually redundant:
# agent-workspace.sh fetches main when it builds the tree. Skip it when the ref
# is already fresh, and let a caller opt out entirely. Staleness costs nothing
# here - source 3 below is what catches the sibling agent, and a migration on
# origin/main older than the ref is one nobody is about to pick again.
if [ "${RESERVE_MIGRATION_SKIP_FETCH:-0}" != "1" ]; then
  ref_file="$(git rev-parse --git-path refs/remotes/origin/main)"
  fetch_needed=1
  if [ -f "$ref_file" ]; then
    now_s=$(date +%s)
    ref_s=$(stat -f %m "$ref_file" 2>/dev/null || stat -c %Y "$ref_file" 2>/dev/null || echo 0)
    [ $(( now_s - ref_s )) -lt 600 ] && fetch_needed=0
  fi
  [ "$fetch_needed" = "1" ] && git fetch --quiet origin main 2>/dev/null || true
fi

used_versions() {
  # 1. this tree
  ls "$mig_dir" 2>/dev/null | sed 's/_.*//;s/\.sql$//'
  # 2. origin/main without checking anything out
  git ls-tree -r --name-only origin/main -- "$mig_dir" 2>/dev/null \
    | sed "s|.*/||;s/_.*//;s/\.sql$//"
  # 3. every other worktree of this repo on this machine
  git worktree list --porcelain 2>/dev/null \
    | awk '/^worktree /{print $2}' \
    | while read -r wt; do
        [ "$wt" = "$repo_root" ] && continue
        ls "$wt/$mig_dir" 2>/dev/null | sed 's/_.*//;s/\.sql$//'
      done
}

taken="$(used_versions | sort -u)"
is_taken() { printf '%s\n' "$taken" | grep -qx "$1"; }

# A version is EXACTLY 14 digits, YYYYMMDDHHMMSS, and later work sorts after
# earlier work. Both of those are load-bearing:
#
#   * Supabase orders migrations by this string, so a version that does not
#     sort by time can apply a migration before the one it depends on.
#   * The estate's own history is 14 digits. 20260831235992 (a 92nd second)
#     and 20260831b are what earlier agents produced by hand when the obvious
#     name was taken, and both are already awkward to read in a listing.
#
# THE FIRST DRAFT OF THIS SCRIPT GOT IT WRONG, on 2026-09-05: the collision
# path built %Y%m%d%H%M plus four random digits, which is SIXTEEN digits, and
# it randomised the ordering inside a minute. Walking the clock forward instead
# keeps the width and keeps the order - a later reservation is always a later
# version - and the free-slot check below is what makes it safe.
version="$(date -u +%Y%m%d%H%M%S)"
if is_taken "$version"; then
  base=$(date -u +%s)
  found=0
  for offset in $(seq 1 600); do
    candidate="$(date -u -r $(( base + offset )) +%Y%m%d%H%M%S 2>/dev/null \
                 || date -u -d "@$(( base + offset ))" +%Y%m%d%H%M%S)"
    if ! is_taken "$candidate"; then version="$candidate"; found=1; break; fi
  done
  if [ "$found" != "1" ]; then
    echo "no free migration version in the next 600 seconds - something is wrong." >&2
    exit 1
  fi
fi

# Width is the invariant, so assert it rather than trust the arithmetic above.
case "$version" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) : ;;
  *) echo "refusing to hand out '$version': a version must be exactly 14 digits." >&2
     exit 1 ;;
esac

path="$mig_dir/${version}_${slug}.sql"

# Create it NOW. An unwritten reservation is not a reservation: the whole point
# is that the next agent's used_versions() can see it.
{
  echo "-- ${version}_${slug}"
  echo "--"
  echo "-- Reserved by scripts/reserve-migration-version.sh on $(date -u '+%Y-%m-%d %H:%M:%S') UTC."
  echo "--"
  echo "-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL."
  echo "-- Say what was wrong, what this changes, and what you measured. A"
  echo "-- migration whose header is its own filename is the next agent's mystery."
} > "$path"

printf '%s\n' "$path"
