#!/usr/bin/env bash
#
# archive-dead-branches.sh — safe replacement for the untracked
# `delete_dead_branches.sh` that was sitting in the repo root on 2026-08-26.
#
# WHAT THE OLD SCRIPT DID
#   gh issue view 375 | ...names... | while read branch; do
#     pr_count=$(gh pr list --head "$branch" --state open --json number -q length)
#     [ "$pr_count" -gt 0 ] && continue
#     git push origin --delete "$branch" || true
#   done
#
# Its only test for "dead" was "has no OPEN pull request". That is not a test for
# whether the branch contains work. At the time it was written the repo had 225
# remote branches and dozens carried commits that were on no other ref:
#
#     fix-table-seated-type .................. 17 commits not in main
#     agent/fix-lobby-remaining-work ......... 15
#     sweep-4-engine-fixes ................... 13
#     security/purge-hardcoded-service-role .. 12
#
# The kill list also included backup/wip-2026-08-20-final,
# backup/wip-2026-08-20-cowork and backup/orphaned-cleanup-2026-08-21 — the exact
# safety-net branches `scripts/git-unstick.sh` creates, per CLAUDE.md section 12.
# Deleting those removes the documented recovery path for the failure mode this
# repo hits most often.
#
# And ancestry alone cannot be trusted here either. CLAUDE.md section 12 records
# that the GitHub-MCP push path re-creates identical CONTENT under a DIFFERENT
# SHA, so `git merge-base --is-ancestor` reports "not merged" for work that is
# demonstrably already on main. Patch-id equivalence is the test that survives
# that.
#
# WHAT THIS SCRIPT DOES INSTEAD
#   1. Never deletes anything matching the PROTECTED patterns.
#   2. Archives every candidate to refs/archive/<name> on the remote BEFORE
#      deleting, so a delete is always reversible.
#   3. Deletes only when the branch is genuinely redundant: either zero commits
#      outside main, or every one of its unique commits has a patch-id already
#      present in main.
#   4. Dry-run by default. Requires an explicit --yes to mutate the remote.
#
# RESTORE AN ARCHIVED BRANCH
#   git fetch origin 'refs/archive/*:refs/archive/*'
#   git push origin refs/archive/<name>:refs/heads/<name>

set -euo pipefail

REMOTE="${REMOTE:-origin}"
APPLY=0
[[ "${1:-}" == "--yes" ]] && APPLY=1

# Branches that are never candidates, whatever else is true of them.
PROTECTED_RE='^(main|master|HEAD)$|^backup/|^land/|^refs/|^archive/|^chore/schema-manifest-|^chore/system-improvements'

say() { printf '%s\n' "$*"; }

if [[ $APPLY -eq 0 ]]; then
  say "DRY RUN — nothing will be archived or deleted. Re-run with --yes to apply."
  say ""
fi

git fetch --prune "$REMOTE" --quiet
MAIN="$(git rev-parse "$REMOTE/main")"

# Every patch-id already reachable from main. A branch whose unique commits all
# appear in here is redundant even when its SHAs differ.
say "Indexing patch-ids on main (this takes a moment)..."
MAIN_PATCH_IDS="$(mktemp)"
trap 'rm -f "$MAIN_PATCH_IDS"' EXIT
git rev-list "$MAIN" --max-count=4000 \
  | while read -r sha; do
      git show "$sha" 2>/dev/null | git patch-id --stable 2>/dev/null | awk '{print $1}'
    done | sort -u > "$MAIN_PATCH_IDS"

kept=0; archived=0; deleted=0

while read -r branch; do
  [[ -z "$branch" ]] && continue
  if [[ "$branch" =~ $PROTECTED_RE ]]; then
    say "PROTECTED  $branch"
    kept=$((kept+1)); continue
  fi

  ahead="$(git rev-list --count "$MAIN..$REMOTE/$branch" 2>/dev/null || echo 0)"

  if [[ "$ahead" -gt 0 ]]; then
    # Does every unique commit already exist on main under another SHA?
    unmatched=0
    while read -r sha; do
      [[ -z "$sha" ]] && continue
      pid="$(git show "$sha" 2>/dev/null | git patch-id --stable 2>/dev/null | awk '{print $1}')"
      if [[ -z "$pid" ]] || ! grep -qx "$pid" "$MAIN_PATCH_IDS"; then
        unmatched=$((unmatched+1))
      fi
    done < <(git rev-list "$MAIN..$REMOTE/$branch")

    if [[ "$unmatched" -gt 0 ]]; then
      say "KEEP       $branch  ($ahead ahead, $unmatched not on main by patch-id)"
      kept=$((kept+1)); continue
    fi
    say "REDUNDANT  $branch  ($ahead ahead, all patch-ids already on main)"
  else
    say "MERGED     $branch  (0 commits outside main)"
  fi

  if [[ $APPLY -eq 1 ]]; then
    # DATED, AND NEVER FORCED (2026-09-03).
    #
    # This wrote `refs/archive/<name>` with `--force`, and that is a way to
    # destroy work in the one tool whose whole promise is that it does not.
    # Branch names get REUSED here - `fix/table-freeze-and-dead-actions` is
    # already sitting in refs/archive from August. Archive that name a second
    # time and the force silently overwrote the first archive, so the August
    # commits became unreachable with no message and no trace.
    #
    # The date suffix makes each archive its own ref, so a reused name adds a
    # second entry instead of replacing the first. It is also the convention
    # .github/scripts/archive-stale-branches.sh uses, so the estate has ONE
    # shape - `refs/archive/<name>@<YYYY-MM-DD>` - rather than two tools
    # disagreeing about where things went.
    #
    # Restoring either is the same command:
    #   git push origin refs/archive/<name>@<date>:refs/heads/<name>
    ARCHIVE_REF="refs/archive/${branch}@$(date -u +%Y-%m-%d)"
    if ! git push "$REMOTE" "$REMOTE/$branch:$ARCHIVE_REF" --quiet; then
      say "           ARCHIVE FAILED for $branch - NOT deleting it."
      continue
    fi
    archived=$((archived+1))
    git push "$REMOTE" --delete "$branch" --quiet
    deleted=$((deleted+1))
    say "           archived -> $ARCHIVE_REF, then deleted"
  fi
done < <(git for-each-ref --format='%(refname:strip=3)' "refs/remotes/$REMOTE/")

say ""
say "kept=$kept archived=$archived deleted=$deleted"
[[ $APPLY -eq 0 ]] && say "DRY RUN — re-run with --yes to apply."
exit 0
