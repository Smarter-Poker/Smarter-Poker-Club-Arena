#!/usr/bin/env bash
# Sort open pull requests into what is SAFE to close and what still holds work.
#
# The estate runs a dozen agents at once. Three things happen to a pull request
# that nobody is coming back to:
#
#   1. SUPERSEDED BY CONTENT. Dan hands a task off; a second agent finishes it
#      on its own branch. The first branch's commits are now upstream under
#      DIFFERENT SHAs, so `git log` says nothing - but `git cherry` compares
#      PATCH IDs, which are content, and reports them as already applied.
#   2. SUPERSEDED BY OUTCOME. Reimplemented differently. Patch ids will not
#      match, but the three-dot diff against main is empty or trivial.
#   3. GENUINELY UNFINISHED. Real unmerged lines. NEVER auto-close these.
#
# Nothing here closes anything. It classifies and prints. Closing is a separate,
# deliberate step, and only after the branch is archived.
set -uo pipefail

AGE_HOURS="${AGE_HOURS:-72}"      # Dan 2026-09-04: under 72h is live work, over is not
REPO="${REPO:-Smarter-Poker/Smarter-Poker-Club-Arena}"
LIMIT="${LIMIT:-200}"

command -v gh >/dev/null || { echo "gh is required" >&2; exit 1; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "run inside the repo" >&2; exit 1; }

git fetch -q origin main || { echo "could not fetch origin/main" >&2; exit 1; }

# Fail closed: an empty or truncated list must not be read as "nothing to do".
PRS="$(gh pr list --repo "$REPO" --state open --limit "$LIMIT" \
        --json number,headRefName,updatedAt,title,mergeStateStatus 2>/dev/null)" || {
  echo "could not list pull requests; refusing to classify on a partial view" >&2; exit 1; }
COUNT="$(echo "$PRS" | jq 'length')"
[ "${COUNT:-0}" -gt 0 ] || { echo "no open pull requests returned; refusing to proceed" >&2; exit 1; }

NOW="$(date -u +%s)"
printf '%-8s %-7s %-9s %-26s %s\n' PR AGE_H VERDICT EVIDENCE TITLE

echo "$PRS" | jq -r '.[] | [.number,.headRefName,.updatedAt,.mergeStateStatus,.title] | @tsv' |
while IFS=$'\t' read -r num branch updated state title; do
  upd="$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$updated" +%s 2>/dev/null || date -u -d "$updated" +%s 2>/dev/null)"
  age=$(( (NOW - ${upd:-$NOW}) / 3600 ))

  # Fetch just this branch. If it is gone, the PR cannot be evaluated.
  if ! git fetch -q origin "refs/heads/$branch:refs/tmp/triage" 2>/dev/null; then
    printf '%-8s %-7s %-9s %-26s %s\n' "#$num" "$age" "NOBRANCH" "head ref missing" "${title:0:52}"
    continue
  fi

  # (1) content already upstream? git cherry compares PATCH IDS, so it sees
  #     work a different agent landed under a different SHA.
  cherry="$(git cherry origin/main refs/tmp/triage 2>/dev/null)"
  total=$(echo "$cherry" | grep -c '^[+-]' || true)
  unmerged=$(echo "$cherry" | grep -c '^+' || true)

  # (2) net content difference against main, ignoring pure whitespace
  netlines=$(git diff --numstat -w origin/main...refs/tmp/triage 2>/dev/null | awk '{a+=$1;d+=$2} END{print a+d+0}')
  netfiles=$(git diff --name-only -w origin/main...refs/tmp/triage 2>/dev/null | wc -l | tr -d ' ')

  if [ "${total:-0}" -gt 0 ] && [ "${unmerged:-0}" -eq 0 ]; then
    verdict="SUPERSEDED"; ev="all $total commits upstream"
  elif [ "${netlines:-0}" -eq 0 ]; then
    verdict="EMPTY";      ev="no diff vs main"
  elif [ "${netlines:-0}" -lt 10 ] && [ "$age" -gt "$AGE_HOURS" ]; then
    verdict="THIN-OLD";   ev="${netlines}L/${netfiles}f, ${age}h"
  elif [ "$age" -gt "$AGE_HOURS" ]; then
    verdict="OLD-WORK";   ev="${netlines}L/${netfiles}f unmerged"
  else
    verdict="LIVE";       ev="${netlines}L/${netfiles}f, ${state:-?}"
  fi

  printf '%-8s %-7s %-9s %-26s %s\n' "#$num" "$age" "$verdict" "$ev" "${title:0:52}"
  git update-ref -d refs/tmp/triage 2>/dev/null || true
done
