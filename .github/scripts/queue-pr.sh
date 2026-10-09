#!/usr/bin/env bash
# Queue one pull request for squash auto-merge without a bypass or reconciler.
set -euo pipefail

REPO="${1:?repository is required}"
PR="${2:?pull request number is required}"

DETAILS=$(gh pr view "$PR" --repo "$REPO" \
  --json state,isDraft,mergeStateStatus,autoMergeRequest,baseRefName)
STATE=$(jq -r '.state' <<<"$DETAILS")
DRAFT=$(jq -r '.isDraft' <<<"$DETAILS")
MERGE_STATE=$(jq -r '.mergeStateStatus' <<<"$DETAILS")
AUTO=$(jq -r 'if .autoMergeRequest then "yes" else "no" end' <<<"$DETAILS")
BASE=$(jq -r '.baseRefName' <<<"$DETAILS")

[ "$STATE" = "OPEN" ] || { echo "PR #$PR is not open; nothing to queue."; exit 0; }
[ "$DRAFT" = "false" ] || { echo "PR #$PR is a draft; leaving it unqueued."; exit 0; }
[ "$AUTO" = "no" ] || { echo "PR #$PR already has auto-merge armed."; exit 0; }


PATCH_FILE=$(mktemp)
gh pr diff "$PR" --repo "$REPO" > "$PATCH_FILE"

if grep -q "^+++ b/src/lib/push/push-gate.js" "$PATCH_FILE" || \
   grep -q "^+++ b/scripts/ci/approved-senders.txt" "$PATCH_FILE" || \
   grep -q "^+++ b/scripts/ci/law-test-no-operational-pushes.mjs" "$PATCH_FILE" || \
   grep -q "^+++ b/src/lib/push/web-push.js" "$PATCH_FILE" || \
   grep -q "^+++ b/src/lib/push/fcm.js" "$PATCH_FILE" || \
   grep -q "^+++ b/pages/api/sms/send-otp.js" "$PATCH_FILE" || \
   grep -q "^+++ b/src/lib/mfaSmsCode.js" "$PATCH_FILE" || \
   grep -q "^+++ b/vendor/commander-shared/src/lib/commander/twilio.js" "$PATCH_FILE" || \
   grep -qE "^\+.*(fn_raise_notification|INSERT INTO public\.notifications|INSERT INTO public\.push_outbox|net\.http_post|sendNotification|twilio.*messages\.create|firebase-admin.*messaging|expo-server-sdk|INSERT INTO public\.ca_incident_recipients)" "$PATCH_FILE"; then
   
   echo "Routing/alerting change detected. Holding for manual review."
   gh pr comment "$PR" --repo "$REPO" --body "⚠️ Auto-merge has been skipped. This PR modifies routing guards, senders, or introduces new alert-to-notification/push code. Manual owner review is required."
   rm "$PATCH_FILE"
   exit 0
fi
rm "$PATCH_FILE"

echo "Queueing #$PR for protected squash auto-merge."
if OUT=$(gh pr merge "$PR" --repo "$REPO" --squash --auto 2>&1); then
  echo "$OUT"
  exit 0
fi

# GitHub refuses --auto after a protected PR is already clean. Direct squash
# merge is safe only after proving the base still requires status checks; the
# server enforces those checks and no --admin path exists here.
if [ "$MERGE_STATE" = "CLEAN" ] || [ "$MERGE_STATE" = "HAS_HOOKS" ]; then
  RULES=$(gh api "repos/$REPO/rules/branches/$BASE")
  REQUIRED=$(jq '[.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[]] | length' <<<"$RULES")
  [ "$REQUIRED" -gt 0 ] \
    || { echo "::error::$BASE has no required checks; refusing a direct merge."; exit 1; }
  gh pr merge "$PR" --repo "$REPO" --squash
  echo "Merged #$PR only after GitHub reported the protected PR clean."
  exit 0
fi

echo "::error::Could not arm protected auto-merge for #$PR (state=$MERGE_STATE): $OUT"
exit 1
