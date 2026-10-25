#!/usr/bin/env bash
# A MERGED MIGRATION IS DISPATCHED BY ITS MERGER (2026-10-25).
#
# Run by agent-autopilot.yml on the pull_request_target `closed` event of a PR
# the autopilot App itself merged. Sends ONE repository_dispatch
# (event_type apply-merged-migration, client_payload {migration, dry_run:false})
# per migration file the PR added, in filename order, after the merge.
#
# apply-merged-migration.yml stays dispatch-only and keeps every guard; this
# is the merger supplying the dispatch a person used to supply. It is not a
# watcher, timer or retry: one run per merge, one attempt per file, and the one
# wait is bounded and happens before anything is sent.
#
# THE BREAK WINDOW. The applier refuses at minute-of-hour :50-:03 UTC (and the
# database through the daily 04:00 Chicago break), and a refused dispatch
# leaves the file uninstalled with nobody owning the retry. So this waits,
# once, until a moment the applier will admit every file (at most
# WAIT_BUDGET_MINUTES, scripts/ci/merged-migration-dispatch.mjs). If that moment
# is beyond the budget, it sends nothing, names every file in the job summary
# and on the PR, and fails the run, so the file is never silently left behind.
#
# Window files ("-- @install-window: daily-maintenance") are never sent here:
# stage-engine-release.yml's window-migrations job installs them inside the
# 04:00 freeze. They are named in the summary as queued for that route.
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN must be the autopilot App installation token}"
REPO="${REPO:?repository is required}"
PR="${PR:?pull request number is required}"
MERGED_BY="${MERGED_BY:-}"
APP_SLUG="${APP_SLUG:?app slug is required}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
PLANNER=scripts/ci/merged-migration-dispatch.mjs

say() { echo "$*" | tee -a "$SUMMARY"; }

{
  echo "### Merged migrations for #$PR"
  echo ""
} >> "$SUMMARY"

# Only the merger dispatches its own merge. A PR merged by a person keeps the
# person as the applier's reader, exactly as before.
if [ "$MERGED_BY" != "${APP_SLUG}[bot]" ]; then
  say "- #$PR was merged by \`${MERGED_BY:-unknown}\`, not by \`${APP_SLUG}[bot]\`; its merger dispatches its migrations."
  exit 0
fi

if [ ! -f "$PLANNER" ]; then
  say "- This repository has no merged-migration planner; nothing to dispatch."
  exit 0
fi

ADDED=$(mktemp)
if ! gh api --paginate "repos/$REPO/pulls/$PR/files?per_page=100" \
    --jq '.[] | select(.status == "added" or .status == "renamed" or .status == "copied") | .filename' \
    > "$ADDED"; then
  say "- **COULD NOT TELL** which files #$PR added: the PR file list was unreadable. Nothing was sent."
  say "- Read the PR's files and dispatch \`apply-merged-migration\` for each added \`supabase/migrations/*.sql\` (filename order) after :03 UTC."
  gh pr comment "$PR" --repo "$REPO" --body "The autopilot merged this PR but could not read its file list, so it dispatched no migration. Dispatch \`apply-merged-migration\` for every \`supabase/migrations/*.sql\` this PR added, in filename order, outside :50-:03 UTC." || true
  exit 1
fi

PLAN=$(node "$PLANNER" plan "$ADDED")
mapfile -t DISPATCH < <(jq -r '.dispatch[]' <<<"$PLAN")
mapfile -t WINDOW < <(jq -r '.windowQueued[]' <<<"$PLAN")
mapfile -t MISSING < <(jq -r '.notOnMain[]' <<<"$PLAN")
mapfile -t MALFORMED < <(jq -r '.malformed[] | "\(.name): \(.reason)"' <<<"$PLAN")
PREAMBLE=$(jq -r 'if .preamble then 1 else 0 end' <<<"$PLAN")

for f in "${WINDOW[@]}"; do
  say "- skipped \`$f\`: declares \`-- @install-window: daily-maintenance\`; it is QUEUED for the daily 03:30 America/Chicago window-migrations run of stage-engine-release.yml, never this door."
done
for f in "${MISSING[@]}"; do
  say "- skipped \`$f\`: added by #$PR but absent from the default branch now; the applier would refuse it."
done
FAIL=0
for f in "${MALFORMED[@]}"; do
  say "- **REFUSED** \`$f\` (malformed install-window declaration; fix the file, then dispatch it)."
  FAIL=1
done

if [ "${#DISPATCH[@]}" -eq 0 ]; then
  say "- no ordinary migration to dispatch."
  exit "$FAIL"
fi

LIST=$(printf '`%s` ' "${DISPATCH[@]}")
if [ "$(jq -r '.withinBudget' <<<"$PLAN")" != "true" ]; then
  say "- **NOT DISPATCHED (break window)**: the applier would not admit ${LIST}within this run's bounded wait (next admitted: $(jq -r '.dispatchAt // "none in two hours"' <<<"$PLAN")). Nothing was sent."
  say "- Dispatch each, in this order, after :03 UTC: ${LIST}"
  echo "::error::Merged migrations not dispatched (break window): ${DISPATCH[*]}"
  gh pr comment "$PR" --repo "$REPO" --body "The autopilot merged this PR inside the migration break window and could not reach an admitted moment within its bounded wait, so NOTHING was dispatched. Dispatch \`apply-merged-migration\` for each, in order, after :03 UTC: ${LIST}" || true
  exit 1
fi

WAIT=$(jq -r '.waitSeconds' <<<"$PLAN")
if [ "$WAIT" -gt 0 ]; then
  say "- break window: waiting ${WAIT}s, once, until $(jq -r '.dispatchAt' <<<"$PLAN") before sending anything."
  sleep "$WAIT"
fi
# The clock moved while waiting; ask once more rather than trust the plan.
if ! node "$PLANNER" admitted "${#DISPATCH[@]}" "$PREAMBLE"; then
  say "- **NOT DISPATCHED**: the applier would still refuse after the wait. Dispatch each, in this order, after :03 UTC: ${LIST}"
  echo "::error::Merged migrations not dispatched: ${DISPATCH[*]}"
  gh pr comment "$PR" --repo "$REPO" --body "The autopilot merged this PR but the migration break window outlasted its bounded wait, so NOTHING was dispatched. Dispatch \`apply-merged-migration\` for each, in order, after :03 UTC: ${LIST}" || true
  exit 1
fi

SENT=0
for f in "${DISPATCH[@]}"; do
  if gh api --method POST "repos/$REPO/dispatches" \
      -f event_type=apply-merged-migration \
      -f "client_payload[migration]=$f" \
      -F "client_payload[dry_run]=false" >/dev/null; then
    say "- dispatched \`$f\` (apply-merged-migration, dry_run false)."
    SENT=$((SENT + 1))
  else
    REST=$(printf '`%s` ' "${DISPATCH[@]:$SENT}")
    say "- **DISPATCH REFUSED** for \`$f\`; not retried. Dispatch each remaining file, in this order: ${REST}"
    echo "::error::apply-merged-migration dispatch refused for $f; remaining: ${DISPATCH[*]:$SENT}"
    gh pr comment "$PR" --repo "$REPO" --body "The autopilot merged this PR and dispatched ${SENT} migration(s), then GitHub refused the dispatch for \`$f\`. Dispatch \`apply-merged-migration\` for each remaining file, in order: ${REST}" || true
    exit 1
  fi
  # Keep creation order, which is the applier's queue order (run id).
  if [ "$SENT" -lt "${#DISPATCH[@]}" ]; then sleep 2; fi
done
say "- the applier's own runs are the outcome: Actions -> Apply Merged Migration."
exit "$FAIL"
