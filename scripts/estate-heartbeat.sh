#!/usr/bin/env bash
# THE ONE WATCHDOG THAT IS NOT A GITHUB ACTIONS WORKFLOW.
#
# On 2026-08-22 at 23:28:34Z GitHub Actions stopped assigning runners to this
# account. Every run created afterwards failed in about three seconds with
# `runner_id: 0`, an empty `steps` array and no logs — the code was never
# checked out. Both repos, every workflow, `main` included. It stayed that way
# for hours.
#
# Nothing said so. `publish-watchdog`, `estate-integrity` and `report-stuck-prs`
# are all GitHub Actions workflows, so when Actions dies they die with it, and
# the entire alarm system goes quiet at precisely the moment it matters. An
# agent noticed by hand and opened an issue.
#
# A watchdog that shares a failure domain with the thing it watches is not a
# watchdog. This one runs on the Mac from launchd. The GitHub REST API is fine
# during an Actions outage — it is only the runners that are gone — so this can
# still read state and still raise the alarm.
#
#   bash scripts/estate-heartbeat.sh          # check once
#   bash scripts/estate-heartbeat.sh --quiet  # only speak when something is wrong
#
# Exit 0 healthy · 1 Actions is not running anybody's code · 2 cannot tell.
set -uo pipefail

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

# How long a run may sit without any job being assigned a runner before this is
# an outage rather than a queue. GitHub queues for a minute or two under load;
# twenty minutes of nothing is not a queue.
STALE_MIN="${HEARTBEAT_STALE_MIN:-20}"
HOME_REPO="${HEARTBEAT_ISSUE_REPO:-Smarter-Poker/Smarter-Poker-Club-Arena}"
TITLE="GitHub Actions is not assigning runners"

REPOS=(Smarter-Poker-Club-Arena Smarter-Poker-World-Hub)

command -v gh >/dev/null || { echo "estate-heartbeat: gh not on PATH"; exit 2; }
gh auth status >/dev/null 2>&1 || { echo "estate-heartbeat: gh is not authenticated"; exit 2; }

NOW=$(date -u +%s)
epoch() { date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$1" +%s 2>/dev/null || date -u -d "$1" +%s 2>/dev/null || echo 0; }

DEAD=()
DETAIL=""

for r in "${REPOS[@]}"; do
  RUNS=$(gh run list --repo "Smarter-Poker/$r" --limit 30 \
           --json databaseId,createdAt,conclusion,status,name 2>/dev/null) || continue
  [ -n "$RUNS" ] || continue
  TOTAL=$(jq 'length' <<<"$RUNS")
  [ "${TOTAL:-0}" -gt 0 ] || continue

  NEWEST=$(jq -r '.[0].createdAt' <<<"$RUNS")
  # The last run that ever got a runner. A success proves one was assigned; for
  # failures we have to ask, because a 3-second failure with runner_id 0 is
  # exactly the shape of the outage.
  LAST_REAL=""
  while read -r id; do
    [ -n "$id" ] || continue
    RID=$(gh api "repos/Smarter-Poker/$r/actions/runs/$id/jobs" \
            --jq '[.jobs[]|select((.runner_id // 0) > 0)]|length' 2>/dev/null || echo 0)
    if [ "${RID:-0}" -gt 0 ]; then
      LAST_REAL=$(jq -r --arg i "$id" '.[]|select(.databaseId|tostring==$i)|.createdAt' <<<"$RUNS")
      break
    fi
  done < <(jq -r '.[].databaseId' <<<"$RUNS" | head -12)

  if [ -z "$LAST_REAL" ]; then
    AGE=$(( (NOW - $(epoch "$NEWEST")) / 60 ))
    DEAD+=("$r")
    DETAIL="${DETAIL}
- **$r** — none of the last 12 runs was ever assigned a runner. Newest run \`$NEWEST\` (${AGE}m ago)."
    continue
  fi

  MINS=$(( (NOW - $(epoch "$LAST_REAL")) / 60 ))
  if [ "$MINS" -gt "$STALE_MIN" ]; then
    DEAD+=("$r")
    DETAIL="${DETAIL}
- **$r** — last run to get a runner was \`$LAST_REAL\`, **${MINS} minutes ago**. Runs created since then fail in seconds with \`runner_id: 0\` and no logs."
  else
    [ "$QUIET" = 1 ] || echo "  $r: healthy — a runner was assigned ${MINS}m ago"
  fi
done

find_issue() {
  gh issue list --repo "$HOME_REPO" --state open --limit 100 --json number,title \
    --jq "[.[] | select(.title == \"$1\")] | .[0].number // empty" 2>/dev/null
}

if [ "${#DEAD[@]}" -eq 0 ]; then
  [ "$QUIET" = 1 ] || echo "estate-heartbeat: OK — Actions is running code."
  N=$(find_issue "$TITLE")
  if [ -n "${N:-}" ]; then
    gh issue comment "$N" --repo "$HOME_REPO" \
      --body "Recovered. A runner has been assigned within the last ${STALE_MIN} minutes. Closing." >/dev/null 2>&1
    gh issue close "$N" --repo "$HOME_REPO" >/dev/null 2>&1 && echo "  closed #$N — Actions is back."
  fi
  exit 0
fi

echo "estate-heartbeat: ACTIONS IS DOWN in ${#DEAD[@]} repo(s): ${DEAD[*]}"

BODY="GitHub Actions is accepting runs and never assigning them a runner.
${DETAIL}

**Signature:** a job completes in about three seconds with \`runner_id: 0\`, an empty \`steps\` array and no logs. The code is never checked out, so this is not a CI failure — nothing ran.

**Why nothing else told you.** \`publish-watchdog\`, \`estate-integrity\` and \`report-stuck-prs\` are all GitHub Actions workflows. When Actions dies they die with it, and the alarm system goes silent exactly when it matters. This check runs on the Mac from launchd for that reason — the REST API works fine during an Actions outage, only the runners are gone.

**What is affected.** Everything. No PR can merge (required checks never report), and \`publish-club-arena.yml\` is what publishes the Club Arena bundle — so nothing reaches smarter.poker by any route until this clears. Production keeps serving whatever last shipped.

**Where to look, in order**

1. **Billing.** These are private repos, so every minute is billed. Included minutes exhausted against a spending limit produces exactly this signature and is by far the most common cause: GitHub → Settings → Billing and licensing → Actions. That is a payment decision for a human.
2. **githubstatus.com** — a platform incident looks the same from here.
3. Repository Actions permissions, if the first two are clean.

**What agents should do meanwhile.** Keep working. Commit, push, open pull requests — none of that needs a runner. The work queues up and merges itself when Actions returns. Do not disable checks, do not merge with \`--admin\`, and do not write a handoff asking a human to deploy.

_Raised by \`scripts/estate-heartbeat.sh\` from launchd on the Mac. It closes itself when a runner is assigned again._"

EXISTING=$(find_issue "$TITLE")
if [ -n "${EXISTING:-}" ]; then
  gh issue edit "$EXISTING" --repo "$HOME_REPO" --body "$BODY" >/dev/null 2>&1 \
    && echo "  updated issue #$EXISTING"
else
  URL=$(gh issue create --repo "$HOME_REPO" --title "$TITLE" --body "$BODY" 2>/dev/null) \
    && echo "  opened $URL"
fi

# Say it on the machine as well. An issue in a repo whose CI is dead is not
# somewhere anybody is looking right now.
osascript -e "display notification \"Actions has not assigned a runner in ${STALE_MIN}+ min. Nothing can merge or publish.\" with title \"Smarter-Poker: GitHub Actions is down\"" 2>/dev/null || true

exit 1
