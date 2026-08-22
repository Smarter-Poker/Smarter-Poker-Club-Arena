#!/usr/bin/env bash
# A PULL REQUEST NOBODY IS COMING BACK FOR.
#
# Autopilot merges anything that CAN merge. What it does with the rest is print
# a line into a run log and move on:
#
#   #33 (fix/x): conflicts with main — an agent must resolve this.
#
# No agent is watching that log. The PR stays open, the work never ships, and
# from the outside that is identical to the feature having regressed — which is
# the complaint this whole system exists to answer. PepNationLab was carrying
# six DIRTY pull requests when this was written, the oldest long cold, and
# nothing anywhere said so.
#
# So the sweep now names them. One issue per repo, updated in place, closed the
# moment the list empties, so it reads as a live indicator and not a backlog.
#
# Three ways a PR gets stuck, and they need different answers:
#
#   DIRTY          real conflict. Autopilot must not touch it: refreshing a
#                  conflicted branch churns CI, and resolving it by taking one
#                  whole side is how the leaderboard RPC call disappeared while
#                  its signature survived. A human or an agent resolves it hunk
#                  by hunk.
#   CHECKS RED     a required check failed. Waiting does nothing. Read the
#                  check and fix the code - never reach for a flag that makes
#                  the check stop applying.
#   NO CHECKS      nothing ever reported. Usually a branch cut before the
#                  workflow existed, or a required context that no job produces.
#                  This one is the quiet killer: the PR waits forever for a
#                  check that will never arrive, and the UI just says "pending".
#
# Env: GH_TOKEN, REPO. Optional STUCK_AFTER_H (default 3).
set -uo pipefail

REPO="${REPO:?}"
STUCK_AFTER_H="${STUCK_AFTER_H:-3}"
TITLE="Agent Autopilot: pull requests that cannot merge on their own"
NOW=$(date -u +%s)

PRS=$(gh pr list --repo "$REPO" --state open --limit 100 \
        --json number,title,headRefName,mergeStateStatus,isDraft,labels,createdAt,updatedAt,author \
      2>/dev/null || echo '[]')

ROWS=""
COUNT=0
while read -r pr; do
  [ -n "$pr" ] || continue
  N=$(jq -r '.number'            <<<"$pr")
  T=$(jq -r '.title'             <<<"$pr")
  BR=$(jq -r '.headRefName'      <<<"$pr")
  ST=$(jq -r '.mergeStateStatus' <<<"$pr")
  DR=$(jq -r '.isDraft'          <<<"$pr")
  WHO=$(jq -r '.author.login // "?"' <<<"$pr")
  CREATED=$(jq -r '.createdAt'   <<<"$pr")
  HOLD=$(jq -r '[.labels[].name] | map(select(.=="do-not-merge" or .=="hold" or .=="wip")) | length' <<<"$pr")

  # A draft or a held PR is stuck ON PURPOSE. Reporting those trains people to
  # ignore the report, which is how a guard stops working.
  [ "$DR" = "true" ] && continue
  [ "$HOLD" != "0" ] && continue

  AGE_H=$(( (NOW - $(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$CREATED" +%s 2>/dev/null \
             || date -u -d "$CREATED" +%s 2>/dev/null || echo "$NOW")) / 3600 ))
  [ "$AGE_H" -lt "$STUCK_AFTER_H" ] && continue

  case "$ST" in
    DIRTY)
      WHY="conflicts with the base branch"
      FIX="resolve it hunk by hunk — never \`--ours\`/\`--theirs\` on a whole file" ;;
    BLOCKED|UNSTABLE)
      LAST=$(gh run list --repo "$REPO" --branch "$BR" --limit 1 \
               --json conclusion,status --jq '.[0] | "\(.status)/\(.conclusion // "-")"' 2>/dev/null || echo "")
      case "$LAST" in
        ""|"null/-")
          WHY="**no check has ever reported**"
          FIX="the branch predates the workflow, or a required context no job produces. Push an empty commit to re-trigger, or fix the ruleset" ;;
        completed/failure|completed/cancelled|completed/timed_out)
          WHY="a required check is $LAST"
          FIX="read the failing check and fix the code" ;;
        in_progress/*|queued/*)
          continue ;;   # genuinely still working
        *)
          WHY="blocked ($ST, last run $LAST)"
          FIX="check whether a required context is missing rather than failing" ;;
      esac ;;
    BEHIND)
      WHY="behind its base and not refreshing"
      FIX="\`gh pr update-branch $N --repo $REPO\`" ;;
    *)
      continue ;;
  esac

  ROWS="${ROWS}| [#${N}](https://github.com/${REPO}/pull/${N}) | \`${BR}\` | ${WHO} | ${AGE_H}h | ${WHY} | ${FIX} |
"
  COUNT=$((COUNT + 1))
done < <(jq -c '.[]' <<<"$PRS")

EXISTING=$(gh issue list --repo "$REPO" --state open --search "$TITLE in:title" \
             --limit 1 --json number --jq '.[0].number' 2>/dev/null || true)

if [ "$COUNT" -eq 0 ]; then
  echo "no stuck pull requests older than ${STUCK_AFTER_H}h."
  if [ -n "${EXISTING:-}" ]; then
    gh issue comment "$EXISTING" --repo "$REPO" \
      --body "Every pull request that was listed here has merged or closed. Nothing is stuck." >/dev/null 2>&1 || true
    gh issue close "$EXISTING" --repo "$REPO" >/dev/null 2>&1 || true
    echo "closed issue #$EXISTING."
  fi
  exit 0
fi

BODY="${COUNT} open pull request(s) have been unable to merge for more than ${STUCK_AFTER_H}h. Autopilot cannot land these on its own — that is the whole reason this list exists rather than a log line nobody reads.

| PR | branch | opened by | age | why it is stuck | what unsticks it |
|---|---|---|---|---|---|
${ROWS}
A pull request that never merges is not a neutral state. The work does not ship, and from outside the repo that is indistinguishable from the feature having regressed.

Whatever you do, do not reach for a flag that makes the check stop applying. \`--admin\` bypassed required checks and put red code on main four times; \`--merge\` and \`--rebase\` are disabled here and fail **silently**, leaving the PR open while the agent reports success.

_Updated in place by \`.github/workflows/agent-autopilot.yml\` on every sweep. It closes itself when the list empties._"

if [ -n "${EXISTING:-}" ]; then
  gh issue edit "$EXISTING" --repo "$REPO" --body "$BODY" >/dev/null 2>&1 \
    && echo "updated issue #$EXISTING with $COUNT stuck PR(s)."
else
  gh issue create --repo "$REPO" --title "$TITLE" --body "$BODY" >/dev/null 2>&1 \
    && echo "opened an issue listing $COUNT stuck PR(s)."
fi

{
  echo "### $COUNT pull request(s) cannot merge on their own"
  echo ""
  echo "| PR | branch | opened by | age | why | fix |"
  echo "|---|---|---|---|---|---|"
  printf '%s' "$ROWS"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
