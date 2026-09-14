#!/usr/bin/env bash
# Queue one pull request for squash auto-merge without a bypass or reconciler.
set -euo pipefail

REPO="${1:?repository is required}"
PR="${2:?pull request number is required}"

read_pr() {
  DETAILS=$(gh pr view "$PR" --repo "$REPO" \
    --json state,isDraft,mergeStateStatus,autoMergeRequest,baseRefName,headRefOid,labels)
  # An incomplete read is not evidence that a concurrent change is harmless.
  jq -e '(.state | IN("OPEN", "CLOSED", "MERGED"))
    and (.isDraft | type == "boolean")
    and (.mergeStateStatus | type == "string")
    and (.baseRefName | type == "string" and length > 0)
    and (.headRefOid | type == "string" and test("^[0-9a-f]{40}$"))
    and has("autoMergeRequest") and (.labels | type == "array")
    and all(.labels[]; .name | type == "string")' <<<"$DETAILS" >/dev/null
  STATE=$(jq -r '.state' <<<"$DETAILS")
  DRAFT=$(jq -r '.isDraft' <<<"$DETAILS")
  MERGE_STATE=$(jq -r '.mergeStateStatus' <<<"$DETAILS")
  AUTO=$(jq -r 'if .autoMergeRequest then "yes" else "no" end' <<<"$DETAILS")
  BASE=$(jq -r '.baseRefName' <<<"$DETAILS")
  HEAD_SHA=$(jq -r '.headRefOid' <<<"$DETAILS")
  HOLD=$(jq -r 'any(.labels[]; .name | IN("do-not-merge", "hold", "wip"))' <<<"$DETAILS")
}

stop_if_changed() {
  [ "$STATE" = "OPEN" ] || { echo "PR #$PR is not open; nothing to queue."; exit 0; }
  [ "$DRAFT" = "false" ] || { echo "PR #$PR is a draft; leaving it unqueued."; exit 0; }
  [ "$HOLD" = "false" ] || { echo "PR #$PR carries a hold label; leaving it unqueued."; exit 0; }
  [ "$AUTO" = "no" ] || { echo "PR #$PR already has auto-merge armed."; exit 0; }
  if [ "$HEAD_SHA" != "$EXPECTED_HEAD" ] || [ "$BASE" != "$EXPECTED_BASE" ]; then
    echo "PR #$PR changed head or base; leaving evaluation to its next event."
    exit 0
  fi
}

read_pr
EXPECTED_HEAD=$HEAD_SHA
EXPECTED_BASE=$BASE
stop_if_changed

echo "Queueing #$PR for protected squash auto-merge."
if OUT=$(gh pr merge "$PR" --repo "$REPO" --squash --auto --match-head-commit "$EXPECTED_HEAD" 2>&1); then
  echo "$OUT"
  exit 0
fi

# The PR can become a draft, close, move head/base, or be queued by another
# actor during the request. Re-read once before considering any fallback.
read_pr
stop_if_changed

# GitHub refuses --auto after a protected PR is already clean. Direct squash
# merge is safe only after proving the base still requires status checks; the
# server enforces those checks and no --admin path exists here.
if [ "$MERGE_STATE" = "CLEAN" ] || [ "$MERGE_STATE" = "HAS_HOOKS" ]; then
  RULES=$(gh api "repos/$REPO/rules/branches/$BASE")
  REQUIRED=$(jq '[.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[]] | length' <<<"$RULES")
  [ "$REQUIRED" -gt 0 ] \
    || { echo "::error::$BASE has no required checks; refusing a direct merge."; exit 1; }
  if OUT=$(gh pr merge "$PR" --repo "$REPO" --squash --match-head-commit "$EXPECTED_HEAD" 2>&1); then
    echo "Merged #$PR only after GitHub reported the protected PR clean."
    exit 0
  fi
  read_pr
  stop_if_changed
fi

echo "::error::Could not arm protected auto-merge for #$PR (state=$MERGE_STATE): $OUT"
exit 1
