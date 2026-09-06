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
# RESERVE_MIGRATION_DIR exists for ONE caller: the law test that proves this
# script works. That test has to create real files to make a version look
# taken, and supabase/migrations/ is read concurrently by a dozen other test
# files - so its fixtures appearing and vanishing mid-scan made THEM fail with
# ENOENT, at random, on work that had nothing to do with migrations. Measured
# 2026-09-05: 44 failures across 7 files in one run, all of them
# "no such file or directory .../20260905155440_the_first_agent_reserves_a_name.sql".
# Unset - which is every real invocation - this is the real directory, and the
# law test asserts that default so the override cannot hide a regression.
mig_dir="${RESERVE_MIGRATION_DIR:-supabase/migrations}"
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

# EVERY SOURCE IS BEST-EFFORT (`|| true` on each).
# This runs under `set -euo pipefail`, so a source that simply has nothing to
# say used to kill the whole reservation: `ls` on a directory that is not there
# exits 1, pipefail promotes that to the pipeline, and the `taken=$(...)`
# assignment below inherits it. A sibling worktree mid-checkout, one that has
# been pruned, or a fresh clone whose supabase/migrations does not exist yet
# would each have taken the script down with "exit 1" and no message. Missing
# is not the same as failing: an absent source contributes no versions, which
# is exactly what an empty line does.
used_versions() {
  # 1. this tree
  { ls "$mig_dir" 2>/dev/null || true; } | sed 's/_.*//;s/\.sql$//'
  # 2. origin/main without checking anything out
  { git ls-tree -r --name-only origin/main -- "$mig_dir" 2>/dev/null || true; } \
    | sed "s|.*/||;s/_.*//;s/\.sql$//"
  # 3. every other worktree of this repo on this machine
  { git worktree list --porcelain 2>/dev/null || true; } \
    | awk '/^worktree /{print $2}' \
    | while read -r wt; do
        [ "$wt" = "$repo_root" ] && continue
        { ls "$wt/$mig_dir" 2>/dev/null || true; } | sed 's/_.*//;s/\.sql$//'
      done
}

taken="$(used_versions | sort -u)"
# A large version set can make grep exit as soon as it finds a match while
# printf is still writing. Under pipefail that turns a real match into SIGPIPE
# status 141, so the caller incorrectly treats a reserved version as free.
# Feed grep through stdin redirection instead; no producer can be cut off.
is_taken() { grep -qx "$1" <<< "$taken"; }

version="$(date -u +%Y%m%d%H%M%S)"
if is_taken "$version"; then
  for _ in $(seq 1 40); do
    candidate="$(date -u +%Y%m%d%H%M)$(printf '%04d' $(( RANDOM % 10000 )))"
    if ! is_taken "$candidate"; then version="$candidate"; break; fi
  done
  if is_taken "$version"; then
    echo "could not find a free migration version in 40 draws - something is wrong." >&2
    exit 1
  fi
fi

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
