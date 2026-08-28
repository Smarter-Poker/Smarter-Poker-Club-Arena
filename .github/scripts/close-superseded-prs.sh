#!/usr/bin/env bash
# A PULL REQUEST THAT PROPOSES NOTHING.
#
# Autopilot lands whatever CAN land. report-stuck-prs.sh NAMES whatever cannot.
# Between those two there was no third step, and that gap is what this closes.
#
# WHAT HAPPENED (Club Arena, 2026-08-26 -> 2026-08-27)
# A swarm opened 455 pull requests in one day. 320 merged, 19 closed, and 116
# were left DIRTY. Autopilot is right not to touch a conflicted branch —
# refreshing one churns CI, and resolving it by taking a whole side is how the
# leaderboard RPC call vanished while its signature survived. report-stuck-prs
# did its job too: issue #375 named all of them, accurately, every 30 minutes,
# for a day and a half.
#
# Nobody acted, because 96 rows of "resolve it hunk by hunk" is not a task list,
# it is wallpaper. And the reason it was 96 rows long is that almost none of
# them needed resolving at all: the same fix had already reached main through a
# sibling pull request from the same swarm. Measured across all 122 open PRs —
# 97 were >=80% already in main, all 26 files the dead-code PR wanted deleted
# were already deleted, and #1181's `safeToClearSeat` guard and #1154's
# one-live-seat migration were both live on main while their pull requests sat
# open claiming to add them.
#
# So the queue was not a backlog of unshipped work. It was 97 copies of shipped
# work, hiding the ~20 that were real.
#
# WHAT THIS DOES
# For a pull request that is conflicted, old enough to be cold, and whose diff
# contributes NOTHING that main does not already contain, it closes the pull
# request and says why. The branch is never deleted and closing is one click to
# undo, so the worst case of a false positive is an annoyance, not a loss.
#
# WHAT IT REFUSES TO TOUCH, and why each rule is here rather than "probably fine"
#
#   * Anything not DIRTY. A mergeable pull request lands on its own; this
#     script has no business having an opinion about it.
#   * Anything younger than MIN_AGE_H (default 24h). Work in progress often
#     looks redundant for an hour. Cold is part of the evidence.
#   * Drafts, and anything labelled do-not-merge / hold / wip / superseded-keep.
#     The last one is the escape hatch: label it and this never looks again.
#   * A pull request that ADDS OR MODIFIES A MIGRATION main does not have.
#     Schema work is the one category where being wrong is expensive and not
#     one click to undo. It is skipped outright, never analysed.
#   * A pull request whose DELETIONS have not been applied to main. Its whole
#     value may be the removal, and a removal leaves no added lines to detect —
#     the line test alone would call it empty and close real work.
#   * A pull request that RENAMES a file main has not renamed, for the same
#     reason: git records a rename as delete+add, and the add side may match
#     main's existing copy line for line.
#
# THE LINE TEST IS DELIBERATELY BLUNT.
# It strips blank lines and lines that are nothing but punctuation — `}`, `);`,
# `<>` — because those match everywhere and prove nothing. It strips NOTHING
# else. Not imports, not comments, not test scaffolding. An earlier draft of
# this stripped those too and it made the "already in main" number look much
# better, which is exactly the problem: every line this filter removes is a line
# that can no longer object to the pull request being closed. A comment main
# does not have is a reason to leave the pull request alone.
#
# Env: GH_TOKEN, REPO. Optional: BASE (default the repo default branch),
#      MIN_AGE_H (24), DRY_RUN (false), LIMIT (200).
set -uo pipefail

REPO="${REPO:?}"
MIN_AGE_H="${MIN_AGE_H:-24}"
DRY_RUN="${DRY_RUN:-false}"
LIMIT="${LIMIT:-200}"
NOW=$(date -u +%s)

BASE="${BASE:-$(gh repo view "$REPO" --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null)}"
BASE="${BASE:-main}"
echo "close-superseded-prs: $REPO base=$BASE min-age=${MIN_AGE_H}h dry-run=$DRY_RUN"

git fetch --quiet origin "$BASE" 2>/dev/null || true
BASE_REF="origin/$BASE"
git rev-parse --verify --quiet "$BASE_REF" >/dev/null || { echo "::warning::no $BASE_REF locally — cannot compare, exiting without closing anything."; exit 0; }

PRS=$(gh pr list --repo "$REPO" --state open --limit "$LIMIT" \
        --json number,isDraft,labels,headRefName,createdAt,title 2>/dev/null) || {
  echo "::warning::could not list pull requests — exiting without closing anything."; exit 0; }

# ── Candidates: cold, unheld, not draft ─────────────────────────────────────
#
# NOTE ON WHY THIS DOES NOT FILTER ON mergeStateStatus.
# The obvious selector is `select(.mergeStateStatus == "DIRTY")`, and it is
# wrong. GitHub computes mergeability LAZILY: `gh pr list --json
# mergeStateStatus` returns "UNKNOWN" for every row until something asks about
# each pull request individually. The first draft of this script used that
# filter, found 0 candidates against a queue of 122 conflicted pull requests,
# and reported success — a guard that could never fire, which is the exact
# failure it was written to catch. Conflict is determined locally with
# git merge-tree below, which is authoritative and needs no API call.
CAND=$(echo "$PRS" | jq -r --argjson now "$NOW" --argjson maxage "$((MIN_AGE_H * 3600))" '
  .[]
  | select(.isDraft == false)
  | select(($now - (.createdAt | fromdateiso8601)) >= $maxage)
  | select([.labels[].name] | any(. == "do-not-merge" or . == "hold" or . == "wip" or . == "superseded-keep") | not)
  | .number')

COUNT=$(echo "$CAND" | grep -c . || true)
echo "candidates (>=${MIN_AGE_H}h old, not draft, not held): ${COUNT:-0}"
[ "${COUNT:-0}" = "0" ] && { echo "nothing to consider."; exit 0; }

# One fetch for every candidate head, rather than one fetch per pull request.
REFSPECS=()
for N in $CAND; do REFSPECS+=("+refs/pull/$N/head:refs/remotes/prhead/$N"); done
git fetch --quiet origin "${REFSPECS[@]}" 2>/dev/null || {
  echo "::warning::could not fetch pull request heads — exiting without closing anything."; exit 0; }

CLOSED=0; KEPT=0
STRIP_NOISE='^[[:space:]]*$|^[[:space:]]*[][(){};,<>/*+=&|?:.-]+[[:space:]]*$'

for N in $CAND; do
  HEAD_REF="refs/remotes/prhead/$N"
  git rev-parse --verify --quiet "$HEAD_REF" >/dev/null || { echo "#$N: head not fetched — skipping."; KEPT=$((KEPT+1)); continue; }

  MB=$(git merge-base "$BASE_REF" "$HEAD_REF" 2>/dev/null) || { echo "#$N: no merge base — skipping."; KEPT=$((KEPT+1)); continue; }

  # Conflicted? Asked locally, because the API answer arrives as UNKNOWN.
  # A pull request that still merges cleanly needs no help from this script:
  # auto-merge will land it, and an empty one lands harmlessly.
  # git merge-tree exits 0 for a clean merge and 1 when the merge conflicts.
  # Read the EXIT CODE, never the output: piping it into grep masks the status
  # behind grep's own, and the conflict report is stage-numbered index entries
  # rather than the "CONFLICT (content)" lines the porcelain merge prints. The
  # first draft grepped for '^CONFLICT', matched nothing, and declared all 118
  # conflicted pull requests clean.
  git merge-tree --write-tree "$BASE_REF" "$HEAD_REF" >/dev/null 2>&1
  MT=$?
  if [ "$MT" -ne 1 ]; then
    # 0 = merges cleanly, auto-merge owns it. Anything else is merge-tree
    # failing to answer, and an unanswered question is not a licence to close.
    echo "#$N: KEEP — merge-tree says $MT (0 = merges cleanly; other = could not tell)."
    KEPT=$((KEPT+1)); continue
  fi

  # ── Refusals, cheapest and most dangerous first ──────────────────────────
  STATUS=$(git diff --name-status -M "$MB" "$HEAD_REF" 2>/dev/null)

  MIGR=$(echo "$STATUS" | awk '$1 ~ /^[AM]/ {print $2}' | grep -E '(^|/)(supabase/migrations|migrations)/' || true)
  PENDING_MIGR=""
  for f in $MIGR; do git cat-file -e "$BASE_REF:$f" 2>/dev/null || PENDING_MIGR="$PENDING_MIGR $f"; done
  if [ -n "$PENDING_MIGR" ]; then
    echo "#$N: KEEP — carries a migration main does not have:$PENDING_MIGR"; KEPT=$((KEPT+1)); continue
  fi

  PENDING_DEL=""
  for f in $(echo "$STATUS" | awk '$1 == "D" {print $2}'); do
    git cat-file -e "$BASE_REF:$f" 2>/dev/null && PENDING_DEL="$PENDING_DEL $f"
  done
  if [ -n "$PENDING_DEL" ]; then
    echo "#$N: KEEP — proposes deletions main has not applied:$PENDING_DEL"; KEPT=$((KEPT+1)); continue
  fi

  PENDING_REN=""
  for f in $(echo "$STATUS" | awk '$1 ~ /^R/ {print $2}'); do
    git cat-file -e "$BASE_REF:$f" 2>/dev/null && PENDING_REN="$PENDING_REN $f"
  done
  if [ -n "$PENDING_REN" ]; then
    echo "#$N: KEEP — proposes renames main has not applied:$PENDING_REN"; KEPT=$((KEPT+1)); continue
  fi

  # ── The line test ────────────────────────────────────────────────────────
  ADDED=$(git diff -M "$MB" "$HEAD_REF" 2>/dev/null \
          | grep -E '^\+' | grep -vE '^\+\+\+' | sed 's/^+//' \
          | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
          | grep -vE "$STRIP_NOISE" | sort -u)

  if [ -z "$ADDED" ]; then
    echo "#$N: KEEP — no added lines at all; that is not a shape this script understands."
    KEPT=$((KEPT+1)); continue
  fi

  TOUCHED=$(git diff --name-only -M "$MB" "$HEAD_REF" 2>/dev/null)
  MAINBLOB=$(mktemp)
  for f in $TOUCHED; do git show "$BASE_REF:$f" 2>/dev/null; done \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | sort -u > "$MAINBLOB"

  MISSING=$(comm -23 <(echo "$ADDED") "$MAINBLOB" | grep -c . || true)
  TOTAL=$(echo "$ADDED" | grep -c . || true)
  rm -f "$MAINBLOB"

  if [ "${MISSING:-1}" -ne 0 ]; then
    echo "#$N: KEEP — $MISSING of $TOTAL added lines are not in $BASE."
    KEPT=$((KEPT+1)); continue
  fi

  echo "#$N: SUPERSEDED — all $TOTAL added lines already exist in $BASE."
  if [ "$DRY_RUN" = "true" ]; then CLOSED=$((CLOSED+1)); continue; fi

  BODY="Closing this as **already shipped**, not as rejected.

Every line it adds is already present in \`$BASE\`, so merging it would change nothing:

- added lines that are not blank or pure punctuation: **$TOTAL**
- of those, not already in \`$BASE\`: **0**
- migrations \`$BASE\` is missing: none
- deletions or renames \`$BASE\` has not applied: none

This is the shape a pull request takes when a sibling branch landed the same
fix first — common when several agents work overlapping scopes in parallel.
The branch \`$(gh pr view "$N" --repo "$REPO" --json headRefName --jq .headRefName 2>/dev/null)\` is **not** deleted.

If this is wrong, reopen it and add the \`superseded-keep\` label and this will
never look at it again. Checked by \`.github/scripts/close-superseded-prs.sh\`."

  if gh pr close "$N" --repo "$REPO" --comment "$BODY" 2>/dev/null; then
    echo "#$N: closed."; CLOSED=$((CLOSED+1))
  else
    echo "::warning::#$N matched but could not be closed."; KEPT=$((KEPT+1))
  fi
done

echo "close-superseded-prs: closed=$CLOSED kept=$KEPT of ${COUNT} candidates (dry-run=$DRY_RUN)"
