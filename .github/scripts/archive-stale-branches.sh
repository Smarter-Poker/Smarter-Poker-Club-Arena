#!/usr/bin/env bash
# archive-stale-branches.sh - branch retention, without ever destroying work.
#
# WHY THIS EXISTS
# ---------------
# On 2026-09-03 this repo had ~570 branches. 176 had already merged through a
# pull request and were simply never deleted; the remaining 400 were triaged by
# hand into `.agent/audits/2026-09-03-unmerged-branch-triage.md`. Most were an
# agent's abandoned first attempt, a rescue snapshot taken by a watchdog, or an
# autofix branch whose fix landed another way.
#
# The cost of leaving them is not disk. It is that every branch picker has 570
# candidates, `orphan-work-watchdog.sh` has 570 branches to walk, and a
# genuinely stranded branch - the thing that watchdog exists to find - is
# invisible inside the noise.
#
# THE ONE RULE: THIS SCRIPT NEVER DESTROYS ANYTHING.
# A branch is copied to `refs/archive/<name>@<date>` FIRST, and only then is
# the branch ref deleted, both in the same atomic push. The commits stay
# reachable forever and restoring one is a single command:
#
#     git push origin refs/archive/my-branch@2026-09-03:refs/heads/my-branch
#
# It also fails CLOSED in every ambiguous case: if it cannot read the open
# pull requests it archives nothing at all, because a branch with an open PR
# is live work by definition however old its last commit is.
#
# SHAPE
# -----
# Two network operations, not one per branch. An earlier draft asked the API
# for each branch's tip in turn; over 400 branches that is 400 round trips and
# it timed out - the identical failure orphan-work-watchdog.sh had, fixed the
# same way. Here one `git fetch` brings every ref and its commit date down at
# once, `git for-each-ref` dates them locally, and one `git push --atomic`
# creates every archive ref and deletes every branch together.
set -euo pipefail

REPO="${REPO:-Smarter-Poker/Smarter-Poker-Club-Arena}"
DRY_RUN="${DRY_RUN:-0}"
MAX_PER_RUN="${MAX_PER_RUN:-40}"     # a bad rule is caught after 40, not 400
STALE_DAYS="${STALE_DAYS:-60}"
SHORT_DAYS="${SHORT_DAYS:-30}"       # machine-made branches expire sooner
TODAY="$(date -u +%Y-%m-%d)"
NOW="$(date -u +%s)"

# Branch classes a machine created, which a machine may retire sooner.
is_short_lived() {
  case "$1" in
    rescue/*|sentry-autofix/*|autofix/*|snapshot/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Never touched, whatever their age.
is_protected() {
  case "$1" in
    main|master|HEAD|develop|release/*|wip/*) return 0 ;;
    *) return 1 ;;
  esac
}

echo "repo            : $REPO"
echo "windows         : ${SHORT_DAYS}d for rescue/autofix/snapshot, ${STALE_DAYS}d otherwise"
echo "cap             : $MAX_PER_RUN per run"
echo "dry run         : $DRY_RUN"
echo

# -- 1. the open-PR set. FAIL CLOSED. ----------------------------------------
OPEN_HEADS=""
if command -v gh >/dev/null 2>&1; then
  OPEN_HEADS=$(gh pr list --repo "$REPO" --state open --limit 400 \
                 --json headRefName --jq '.[].headRefName' 2>/dev/null || true)
else
  # No gh (a workstation). REST, with the token every agent already has.
  TOK="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  if [ -n "$TOK" ]; then
    for pg in 1 2 3 4; do
      MORE=$(curl -sS -m 45 -H "Authorization: Bearer $TOK" \
        "https://api.github.com/repos/${REPO}/pulls?state=open&per_page=100&page=${pg}" \
        | python3 -c 'import json,sys
d = json.load(sys.stdin)
if isinstance(d, list):
    for p in d: print(p["head"]["ref"])' 2>/dev/null || true)
      [ -z "$MORE" ] && break
      OPEN_HEADS="${OPEN_HEADS}
${MORE}"
      [ "$(printf '%s\n' "$MORE" | grep -c .)" -lt 100 ] && break
    done
  fi
fi

if [ -z "$(printf '%s' "$OPEN_HEADS" | tr -d '[:space:]')" ]; then
  echo "::warning::could not read the open pull requests - archiving nothing this run."
  echo "(this is the fail-closed path: a branch with an open PR is live work.)"
  exit 0
fi
echo "open pull requests: $(printf '%s\n' "$OPEN_HEADS" | grep -c . || true) (their branches are exempt)"

# -- 2. every branch and its date, in ONE fetch ------------------------------
git fetch --prune --quiet origin '+refs/heads/*:refs/remotes/origin/*'

CANDIDATES=""
TOTAL=0
while read -r TS BR; do
  [ -z "${BR:-}" ] && continue
  BR="${BR#origin/}"
  [ "$BR" = "HEAD" ] && continue
  TOTAL=$((TOTAL + 1))
  is_protected "$BR" && continue
  printf '%s\n' "$OPEN_HEADS" | grep -qxF "$BR" && continue

  if is_short_lived "$BR"; then WINDOW=$((SHORT_DAYS * 86400)); else WINDOW=$((STALE_DAYS * 86400)); fi
  [ $((NOW - TS)) -lt "$WINDOW" ] && continue

  CANDIDATES="${CANDIDATES}${BR} $(( (NOW - TS) / 86400 ))
"
done < <(git for-each-ref --format='%(committerdate:unix) %(refname:short)' refs/remotes/origin)

echo "branches        : $TOTAL"

# Oldest first, capped.
PICKED=$(printf '%s' "$CANDIDATES" | grep . | sort -k2 -rn | head -n "$MAX_PER_RUN" || true)
N=$(printf '%s\n' "$PICKED" | grep -c . || true)
echo "eligible now    : $(printf '%s' "$CANDIDATES" | grep -c . || true), archiving $N this run"
echo

if [ "$N" = "0" ]; then echo "nothing to do."; exit 0; fi

# -- 3. archive THEN delete, in one atomic push ------------------------------
# --atomic means: if any archive ref fails to create, NOTHING is deleted.
REFSPECS=()
while read -r BR AGE; do
  [ -z "${BR:-}" ] && continue
  SHA=$(git rev-parse "refs/remotes/origin/${BR}")
  printf '  %-56s %4sd  -> refs/archive/%s@%s\n' "$BR" "$AGE" "$BR" "$TODAY"
  REFSPECS+=("${SHA}:refs/archive/${BR}@${TODAY}" ":refs/heads/${BR}")
done <<< "$PICKED"

echo
if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN - nothing pushed. ${#REFSPECS[@]} refspecs prepared."
  echo "restore any of the above with:"
  echo "  git push origin refs/archive/<branch>@${TODAY}:refs/heads/<branch>"
  exit 0
fi

# Push with the token EXPLICITLY, never the credential actions/checkout
# persisted: that one is GITHUB_TOKEN, which can read the repo but cannot
# write refs/archive/* or delete a branch. Relying on it would mean this
# works in every dry run and fails the first time it is armed.
PUSH_REMOTE="origin"
if [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ] && [ -n "${GITHUB_ACTIONS:-}" ]; then
  PUSH_REMOTE="https://x-access-token:${GH_TOKEN:-$GITHUB_TOKEN}@github.com/${REPO}.git"
fi
git push --atomic "$PUSH_REMOTE" "${REFSPECS[@]}"
echo
echo "archived and retired $N branches. Nothing was destroyed - each is at"
echo "refs/archive/<name>@${TODAY} and restores with a single push."
