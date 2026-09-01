#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  ENGINE WATCHDOG — is the Hetzner engine running the code main says it should?
#
#  publish-watchdog.sh asks that question of the CLIENT bundle. Nothing asked it
#  of the ENGINE, and the engine is where the money is.
#
#  WHY THIS EXISTS (2026-08-27). auto-deploy-hetzner.yml is careful in exactly
#  the ways that make it quiet:
#
#    * it COALESCES a restart inside MIN_RESTART_SPACING_SEC (1200s) and exits 0;
#    * the drain gate DEFERS while hands are in flight and exits 0;
#
#  both of which are correct, and both of which report SUCCESS. A `*/20` catch-up
#  schedule is supposed to land the deferred commit, but GitHub's scheduled runs
#  are best-effort and can be delayed for a long time under load. On 2026-08-27 a
#  merged engine fix sat unshipped for about two hours with a green tick on every
#  run, and only landed because a human dispatched the workflow by hand.
#
#  So: a green tick on the deploy answers "did this run do the right thing".
#  It does not answer "is production running main". This asks production.
#
#  WHAT IT DOES, in order:
#    1. finds the newest commit on main that touches the engine's runtime;
#    2. reads $ENGINE_URL/health and takes `version`, the sha it is serving;
#    3. if the engine is at or ahead of that commit, closes any open alarm;
#    4. inside the grace window, says so and stops - a deploy in progress or one
#       waiting on the drain gate is NORMAL and must not raise an alarm;
#    5. past it, DISPATCHES the deploy itself (RULE 5: never ask a human to run
#       a command) and raises one self-closing issue.
#
#  IT NEVER FAILS THE JOB ON AN UNREADABLE ENGINE. /health being unreachable is
#  an availability problem with its own alerting; guessing "behind" from silence
#  would dispatch restarts into an outage.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

ENGINE_URL="${ENGINE_URL:-https://engine.smarter.poker}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
DEPLOY_WORKFLOW="${DEPLOY_WORKFLOW:-auto-deploy-hetzner.yml}"
# A floor, not the deadline. The engine does not restart on merge, so "N
# minutes after the commit" was never a deadline it was trying to meet. The
# real deadline is the first restart window at or after the commit plus one
# deploy's worth of time, and GRACE_MIN only stops this firing sooner than that
# when a commit lands moments before a window.
GRACE_MIN="${GRACE_MIN:-45}"
#
# HOURLY, AT :55 (Dan 2026-09-01: "every hour on the :55 instead of every 5
# hours so nothing gets lost or orphaned from production improvements").
#
# This used to carry RESTART_HOURS="04 10 14 18 22" to mirror the five Chicago
# windows. Both halves of that are now wrong, and leaving either would have
# made this watchdog useless in opposite directions:
#
#   * the HOURS are wrong - every hour is a window now, so a deadline computed
#     from the old five would sit up to six hours late and this would stay
#     quiet through a whole morning of genuinely stranded code;
#   * the MINUTE is wrong - the window opens at :55, not at the top of the
#     hour, so a deadline anchored to :00 fires 55 minutes early and alarms
#     about a platform behaving exactly as designed. An alarm that is right
#     about the reading and wrong about whether anything is broken is how
#     people learn to close alarms unread.
#
# There is no timezone here any more either. :55 is the same minute in every
# whole-hour offset, which is the same reason the deploy workflow could drop
# its Chicago gate.
BREAK_MINUTE="${BREAK_MINUTE:-55}"                # matches MaintenanceBreak.BREAK_START_MINUTE
DEPLOY_MIN="${DEPLOY_MIN:-25}"                    # a real deploy is ~5m; 25 leaves room for the break
ISSUE_TITLE="Engine watchdog: production is not running main"

chicago_hour() {  # $1 = epoch -> HH in America/Chicago (GNU date, BSD fallback)
  TZ=America/Chicago date -d "@$1" +%H 2>/dev/null || TZ=America/Chicago date -r "$1" +%H
}
chicago_stamp() {
  TZ=America/Chicago date -d "@$1" '+%Y-%m-%d %H:%M %Z' 2>/dev/null \
    || TZ=America/Chicago date -r "$1" '+%Y-%m-%d %H:%M %Z'
}
# The opening of the first restart window at or after $1 - i.e. the next :55.
#
# Epoch arithmetic, no timezone: :55 past the hour is the same instant in every
# whole-hour offset, and every hour is a window. A commit landing at :56 has
# just missed one and waits for the next; one landing at :10 catches the same
# hour's.
window_at_or_after() {
  local e=$1 hour_start cand
  hour_start=$(( e / 3600 * 3600 ))
  cand=$(( hour_start + BREAK_MINUTE * 60 ))
  if [ "$cand" -lt "$e" ]; then cand=$(( cand + 3600 )); fi
  printf '%s' "$cand"
}

say() { printf '%s\n' "$*"; }
summary() { [ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"; return 0; }

# The plain list endpoint, not `--search`: the search index is eventually
# consistent and two sweeps minutes apart will both "find nothing" and both file
# an issue. A de-duplicating guard that duplicates is worse than none.
# Same token for the read as for the write, for the same reason.
find_issue() {
  GH_TOKEN="${GH_TOKEN_ISSUES:-${GH_TOKEN:-}}" \
  gh issue list --repo "$REPO" --state open --limit 100 --json number,title \
    --jq "[.[] | select(.title == \"$1\")] | .[0].number // empty" 2>/dev/null
}

gh_write() {
  local what="$1"; shift
  local out
  if out=$(GH_TOKEN="${GH_TOKEN_ISSUES:-${GH_TOKEN:-}}" gh "$@" 2>&1); then
    say "  $what"
    return 0
  fi
  say "::error::engine-watchdog could not $what -- the engine is behind and nobody was told."
  printf '%s\n' "$out" | sed 's/^/    /'
  return 1
}

close_issue() {
  local n
  n=$(find_issue "$ISSUE_TITLE")
  [ -n "${n:-}" ] || return 0
  gh_write "comment on #$n" issue comment "$n" --repo "$REPO" \
    --body "Recovered. The engine is serving \`$SERVED\`, which contains \`$REQ_SHORT\`. Closing." || true
  gh_write "close issue #$n (engine caught up)" issue close "$n" --repo "$REPO" || true
}

# ── 1. What SHOULD the engine be running? ───────────────────────────────────
#
# The newest commit touching server/, minus the paths auto-deploy-hetzner
# deliberately ignores: a test or a sim change never enters the runtime image,
# so demanding the engine serve one would raise a permanent false alarm.
REQ_SHA=$(git log origin/main -1 --format=%H -- \
  'server/**' ':(exclude)server/**/*.test.ts' ':(exclude)server/sim/**' 2>/dev/null)

if [ -z "${REQ_SHA:-}" ]; then
  say "No engine-affecting commit found on main. Nothing to compare."
  summary "### Engine watchdog: nothing to check"
  exit 0
fi
REQ_SHORT=${REQ_SHA:0:8}
REQ_EPOCH=$(git show -s --format=%ct "$REQ_SHA")
REQ_TIME=$(git show -s --format=%cI "$REQ_SHA")
AGE_MIN=$(( ( $(date -u +%s) - REQ_EPOCH ) / 60 ))

# ── 2. What IS it running? ──────────────────────────────────────────────────
HEALTH=$(curl -fsSL --max-time 15 -H 'Cache-Control: no-cache' "$ENGINE_URL/health" 2>/dev/null || true)
SERVED=$(printf '%s' "$HEALTH" | python3 -c \
  'import json,sys
try:
    print(json.load(sys.stdin).get("version") or "")
except Exception:
    print("")' 2>/dev/null || true)

say "main needs : $REQ_SHORT ($REQ_TIME, ${AGE_MIN}m ago)"
say "engine has : ${SERVED:-<unreadable>}"

if [ -z "${SERVED:-}" ]; then
  # Availability is a different alarm with a different owner. Guessing "behind"
  # from silence would dispatch restarts into an outage.
  say "::warning title=ENGINE HEALTH UNREADABLE::$ENGINE_URL/health did not answer, so this run cannot say whether the engine is current. Not dispatching anything."
  summary "### Engine watchdog: /health unreadable"
  summary ""
  summary "No comparison was possible. This is deliberately NOT treated as \"behind\"."
  exit 0
fi

# ── 3. Current? ─────────────────────────────────────────────────────────────
# `--is-ancestor REQ SERVED` is true when the engine is at that commit OR ahead
# of it, which is the honest question. An equality check would cry wolf every
# time the engine legitimately ran a newer sha than the last server change.
if git cat-file -e "${SERVED}^{commit}" 2>/dev/null && \
   git merge-base --is-ancestor "$REQ_SHA" "$SERVED" 2>/dev/null; then
  say "OK — the engine is running main."
  summary "### Engine watchdog: OK"
  summary ""
  summary "Engine serves \`$SERVED\`, which contains \`$REQ_SHORT\`."
  close_issue
  exit 0
fi

# ── 4. Behind, but not yet late ─────────────────────────────────────────────
# Two things must be true before this is a fault: a restart window has to have
# OPENED since the commit landed, and enough time has to have passed inside it
# for a deploy to finish. Before that the engine is behind exactly as designed
# and there is nothing to report.
NOW_EPOCH=$(date -u +%s)
WINDOW_EPOCH=$(window_at_or_after "$REQ_EPOCH")
WINDOW_START=$(( WINDOW_EPOCH > REQ_EPOCH ? WINDOW_EPOCH : REQ_EPOCH ))
DEADLINE=$(( WINDOW_START + DEPLOY_MIN * 60 ))
GRACE_DEADLINE=$(( REQ_EPOCH + GRACE_MIN * 60 ))
[ "$GRACE_DEADLINE" -gt "$DEADLINE" ] && DEADLINE=$GRACE_DEADLINE
WINDOW_LOCAL=$(chicago_stamp "$WINDOW_EPOCH")

if [ "$NOW_EPOCH" -lt "$DEADLINE" ]; then
  say "Behind by design: the engine restarts inside the :${BREAK_MINUTE} maintenance break."
  say "  first window at or after $REQ_SHORT: $WINDOW_LOCAL, +${DEPLOY_MIN}m to deploy"
  # Say WHICH deadline is holding this quiet. When the grace window is the
  # later of the two, the window has already opened and the engine simply has
  # not caught up yet: one missed catch-up tick is ordinary, three in a row is
  # the failure this watchdog exists to name. A reader of a quiet run could
  # not tell those apart before.
  if [ "$DEADLINE" -eq "$GRACE_DEADLINE" ]; then
    say "  quiet because $REQ_SHORT is still inside the ${GRACE_MIN}m grace window"
  fi
  summary "### Engine watchdog: waiting for the restart window"
  summary ""
  summary "\`$REQ_SHORT\` is ${AGE_MIN}m old and the engine serves \`$SERVED\`. The engine does not restart on merge: its first window opens **$WINDOW_LOCAL**, and this watchdog stays quiet until ${DEPLOY_MIN}m past it."
  exit 0
fi

# ── 5. Behind for too long. Fix it, then say so. ────────────────────────────
say "::warning title=ENGINE BEHIND::$REQ_SHORT has been on main for ${AGE_MIN}m and the engine still serves $SERVED."

# Dispatch only when a restart window is actually open. Outside one, the deploy
# exits in 20 seconds having shipped nothing, and an alarm that claims "a retry
# has been dispatched" when the retry provably cannot do anything is worse than
# an alarm that says nothing.
DISPATCHED="no"
NOW_TS=$(date -u +%s)
NEXT_WINDOW_EPOCH=$(window_at_or_after "$NOW_TS")
NEXT_WINDOW_LOCAL=$(chicago_stamp "$NEXT_WINDOW_EPOCH")
# Dispatch only when the next :55 is close enough that the run will still be
# alive and waiting when the break opens. The deploy's break gate polls for
# about 14 minutes; dispatching at :10 would burn a runner for 14 minutes and
# then give up with BREAK NEVER OPENED, having provably fixed nothing, and an
# alarm that claims a retry was dispatched when the retry could not work is
# worse than one that says nothing.
MINS_TO_WINDOW=$(( (NEXT_WINDOW_EPOCH - NOW_TS) / 60 ))
if [ "$MINS_TO_WINDOW" -le 13 ]; then
  if gh workflow run "$DEPLOY_WORKFLOW" --repo "$REPO" --ref main >/dev/null 2>&1; then
    DISPATCHED="yes"
    say "  dispatched $DEPLOY_WORKFLOW on main"
  else
    say "::error::could not dispatch $DEPLOY_WORKFLOW -- the engine is behind and this run could not even try to fix it."
  fi
else
  DISPATCHED="no - outside the restart window, where a dispatch ships nothing"
  say "  not dispatching: $NOW_HOUR:00 Chicago is not a restart hour. Next window $NEXT_WINDOW_LOCAL."
fi

BODY=$(cat <<EOF
The engine is not running main.

| | |
| --- | --- |
| main needs | \`$REQ_SHORT\` ($REQ_TIME, **${AGE_MIN}m** ago) |
| engine serves | \`$SERVED\` |
| deploy dispatched by this run | $DISPATCHED |
| next restart window | $NEXT_WINDOW_LOCAL |

\`$REQ_SHORT\` is the newest commit touching the engine runtime, excluding tests
and sim, which never enter the image.

**The engine restarts on a schedule, not on a merge.** It restarts inside the
five-minute maintenance break that runs at :${BREAK_MINUTE} of every hour, so
being behind between windows is normal and this watchdog stays silent for it.
Seeing this issue at all means a window has already opened since the commit and
passed without the engine catching up - which, on an hourly schedule, is a real
failure rather than a wait.

**Why a green deploy is not an answer.** \`auto-deploy-hetzner.yml\` coalesces a
restart inside MIN_RESTART_SPACING_SEC and exits 0, and the drain gate defers
while hands are in flight and exits 0. Both are correct and both report success,
so the deploy run being green tells you nothing about what production runs. A
run of 11-20s shipped nothing; a real deploy takes about five minutes.

**If this is still open on the next sweep**, the deploy is being refused rather
than deferred. Read the newest \`Auto-Deploy Hetzner Engine\` run: the drain gate
holds while hands are in flight and gives up only after the 6h staleness cap,
and the coalesce gate holds for 1200s after a restart. Anything else is a real
failure and will be in that log.

This issue closes itself when the engine catches up.
EOF
)

EXISTING=$(find_issue "$ISSUE_TITLE")
if [ -n "${EXISTING:-}" ]; then
  gh_write "comment on #$EXISTING" issue comment "$EXISTING" --repo "$REPO" \
    --body "Still behind. main needs \`$REQ_SHORT\` (${AGE_MIN}m old); the engine serves \`$SERVED\`. Deploy dispatched by this run: $DISPATCHED." || true
else
  gh_write "open an issue" issue create --repo "$REPO" --title "$ISSUE_TITLE" --body "$BODY" || true
fi

summary "### Engine watchdog: BEHIND"
summary ""
summary "main needs \`$REQ_SHORT\` (${AGE_MIN}m old); the engine serves \`$SERVED\`. Deploy dispatched: $DISPATCHED."

# The alarm is raised and the deploy is dispatched. Failing the job as well
# would turn every deferred restart into a red workflow that nobody can act on
# faster than the watchdog already has.
exit 0
