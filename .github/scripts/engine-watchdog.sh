#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  ENGINE WATCHDOG — is the Hetzner engine running the code main says it should?
#
#  publish-watchdog.sh asks that question of the CLIENT bundle. Nothing asked it
#  of the ENGINE, and the engine is where the money is.
#
#  WHY THIS EXISTS (2026-08-27). auto-deploy-hetzner.yml was careful in exactly
#  the ways that made it quiet:
#
#    * it COALESCED a restart inside MIN_RESTART_SPACING_SEC (1200s) and exited 0
#      (deleted 2026-09-10: the :55 break is the spacing);
#    * the drain gate DEFERRED while hands were in flight and exited 0 (a
#      decline is RED since 2026-09-10, and hands the train on);
#
#  both of which were correct, and both of which reported SUCCESS. A `*/20` catch-up
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
#    5. past it, raises one self-closing issue that says whether a deploy run is
#       in flight - and NEVER dispatches one (2026-09-10, Dan: "i do not want
#       any watch dogs"). The deploy train is started by every engine push and
#       hands itself on inside auto-deploy-hetzner.yml; a watchdog that starts
#       deploys is a band-aid on a trigger that does not work, and on
#       2026-09-09 this one's dispatches cancelled the very run that was waiting
#       for the break.
#
#  IT NEVER FAILS THE JOB ON AN UNREADABLE ENGINE. /health being unreachable is
#  an availability problem with its own alerting; guessing "behind" from silence
#  would raise a false alarm in the middle of an outage.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

ENGINE_URL="${ENGINE_URL:-https://engine.smarter.poker}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
DEPLOY_WORKFLOW="${DEPLOY_WORKFLOW:-auto-deploy-hetzner.yml}"
# Two full catch-up cycles plus a margin. One missed */20 tick is ordinary;
# three in a row is the failure this exists to catch.
GRACE_MIN="${GRACE_MIN:-45}"
# The engine does not restart on merge. Since #2343 auto-deploy-hetzner.yml only
# lets a restart through during scheduled Chicago hours, so "45 minutes after the
# merge" was never a deadline the engine was trying to meet -- and between the
# 04:00 and 10:00 windows this watchdog was guaranteed to fire every morning
# about a platform behaving exactly as designed. An alarm that is right about the
# reading and wrong about whether anything is broken is how people learn to close
# alarms unread. The deadline is the first restart window at or after the commit,
# plus one deploy's worth of time -- and never sooner than GRACE_MIN, so this is
# strictly more patient than what it replaces, never less.
# ── EVERY HOUR, ON THE :55 (Dan, 2026-09-01) ───────────────────────────────
# This used to be RESTART_HOURS="04 10 14 18 22", America/Chicago, with the
# comment "matches auto-deploy-hetzner.yml". It stopped matching the moment
# #2527 landed the hourly break at 13:00 UTC, and the mismatch made this
# watchdog silent for the rest of the day.
#
# MEASURED. At 18:32 UTC the engine was serving the 03:54 image with five
# merged pull requests unshipped for fourteen and a half hours, and the job
# reported SUCCESS. The arithmetic that produced that: the newest
# server-touching commit was early afternoon Chicago, window_at_or_after
# rounded it up to the next FIVE-HOUR window at 14:00 Chicago (19:00 UTC),
# the deadline became 19:25 UTC, and 18:32 is comfortably before it. The
# watchdog was waiting for a window the deploy workflow no longer has.
#
# So the window is now a MINUTE, not an hour. Every hour has one, the restart
# happens inside the announced break at :55, and the deadline is measured from
# that boundary rather than from the top of some rationed hour.
RESTART_MINUTE="${RESTART_MINUTE:-55}"            # matches auto-deploy-hetzner.yml
DEPLOY_MIN="${DEPLOY_MIN:-25}"                    # a real deploy is ~5m; 25 leaves room for a drain
ISSUE_TITLE="Engine watchdog: production is not running main"

chicago_hour() {  # $1 = epoch -> HH in America/Chicago (GNU date, BSD fallback)
  TZ=America/Chicago date -d "@$1" +%H 2>/dev/null || TZ=America/Chicago date -r "$1" +%H
}
chicago_stamp() {
  TZ=America/Chicago date -d "@$1" '+%Y-%m-%d %H:%M %Z' 2>/dev/null \
    || TZ=America/Chicago date -r "$1" '+%Y-%m-%d %H:%M %Z'
}
# Every hour is a restart window now, so there is no longer an hour that is
# not one. Kept as a function because the report below reads better for it,
# and because a future rationing change has one place to go.
is_restart_hour() { return 0; }

# The next :55 at or after $1 - the moment the announced break opens and the
# restart can actually happen. "At or after" matters: a commit landing at
# 10:55:30 has missed that break by thirty seconds and waits for 11:55, which
# is what the deploy workflow does too.
window_at_or_after() {
  local e=$1 hour_floor cand
  hour_floor=$(( e / 3600 * 3600 ))
  cand=$(( hour_floor + RESTART_MINUTE * 60 ))
  [ "$cand" -lt "$e" ] && cand=$(( cand + 3600 ))
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

# ── THE TRAIN, NOT JUST THE CARGO (added 2026-09-02, after the outage) ──────
# Staleness asks "is a server commit waiting". The 2026-09-02 outage began
# with main going red on a MIGRATIONS-ONLY merge: nothing server-touching was
# queued, REQ equaled SERVED, and this watchdog said OK for hours while the
# deploy workflow's own test gate refused every window that was coming. A
# broken train with no cargo is still a broken train. Two consecutive real
# failures (cancelled runs are superseded dispatches, not verdicts) raise one
# self-closing issue that names the failing step, so the reader starts at the
# cause instead of rediscovering it from the Actions tab.
TRAIN_TITLE="Engine watchdog: the hourly deploy train is failing"
train_check() {
  local RUNS latest prev url rid step n
  RUNS=$(gh run list --repo "$REPO" --workflow "$DEPLOY_WORKFLOW" --limit 12 \
    --json conclusion,status,url,databaseId,workflowName \
    --jq '[.[] | select(.status=="completed" and .conclusion!="cancelled")
               | .conclusion |= (if . == "timed_out" or . == "startup_failure" then "failure" else . end)] | .[0:2]' 2>/dev/null || echo "")
  latest=$(printf '%s' "$RUNS" | jq -r '.[0].conclusion // "none"' 2>/dev/null || echo none)
  prev=$(printf '%s' "$RUNS" | jq -r '.[1].conclusion // "none"' 2>/dev/null || echo none)
  url=$(printf '%s' "$RUNS" | jq -r '.[0].url // ""' 2>/dev/null || echo "")
  if [ "$latest" = "failure" ] && [ "$prev" = "failure" ]; then
    rid=$(printf '%s' "$RUNS" | jq -r '.[0].databaseId // ""' 2>/dev/null || echo "")
    step=$(gh run view "$rid" --repo "$REPO" --json jobs \
      --jq '[.jobs[].steps[] | select(.conclusion=="failure")][0].name // "unknown step"' 2>/dev/null || echo "unknown step")
    say "::warning title=DEPLOY TRAIN FAILING::the last two completed deploy runs failed. Latest failing step: $step"
    # Since 2026-09-10 the LAST step, "Verdict", fails a run that should have
    # shipped and did not. That is not a gate refusing on a broken main: the
    # reason is the run's own DID NOT SHIP annotation and its ledger row.
    local advice="Start at the failing step above - it is the gate that is refusing, and the gate is usually right (fix main, never the gate)."
    case "$step" in
      Verdict*) advice="The Verdict step failed: the run should have shipped and did not. Its DID NOT SHIP annotation, and the reason column of ca_engine_deploy_attempts for that run_id, name the gate that held (budget, or no readyForRestart certificate). Fix that gate's cause; do not bypass the certificate." ;;
    esac
    local wname
    wname=$(printf '%s' "$RUNS" | jq -r '.[0].workflowName // ""' 2>/dev/null || echo "")
    n=$(find_issue "$TRAIN_TITLE")
    if [ -n "${n:-}" ]; then
      gh_write "comment on #$n" issue comment "$n" --repo "$REPO" \
        --body "Still failing. Latest failing step: **$step**. $url" || true
    else
      gh_write "open the train issue" issue create --repo "$REPO" --title "$TRAIN_TITLE" --body "The last two completed (non-cancelled) runs of \`$DEPLOY_WORKFLOW\` FAILED.

| | |
| --- | --- |
| workflow | ${wname:-$DEPLOY_WORKFLOW} (\`$DEPLOY_WORKFLOW\`) |
| latest failing step | **$step** |
| latest run | $url |

A failing train strands every merge whether or not the engine is currently behind. On 2026-09-02 main went red on a migrations-only merge while nothing server-touching was queued: the staleness alarm had nothing to say, and every window for the next three hours was already lost. $advice

This issue closes itself on the first completed deploy run that succeeds." || true
    fi
  elif [ "$latest" = "success" ]; then
    n=$(find_issue "$TRAIN_TITLE")
    if [ -n "${n:-}" ]; then
      gh_write "comment on #$n" issue comment "$n" --repo "$REPO" \
        --body "Recovered. The latest completed deploy run succeeded. Closing." || true
      gh_write "close issue #$n (train recovered)" issue close "$n" --repo "$REPO" || true
    fi
  fi
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

# Train health runs on EVERY sweep, before any early exit: a broken train
# with an up-to-date engine is precisely the state the early exits hide.
train_check

if [ -z "${SERVED:-}" ]; then
  # Availability is a different alarm with a different owner. Guessing "behind"
  # from silence would dispatch restarts into an outage.
  say "::warning title=ENGINE HEALTH UNREADABLE::$ENGINE_URL/health did not answer, so this run cannot say whether the engine is current. Not raising a staleness alarm on silence."
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

# ── THE CLOCK STARTS WHEN PRODUCTION FELL BEHIND, NOT AT THE NEWEST MERGE ────
#
# 2026-09-02: this watchdog stayed quiet through FOURTEEN HOURS of stranded
# engine code, reporting "Behind by design" on every run, while production sat
# on 93d167b5 and the deploy fail-closed at every window.
#
# The arithmetic did it. Both deadlines were anchored to REQ_EPOCH - the
# NEWEST engine commit on main - so every new engine merge pushed the deadline
# forward another GRACE_MIN. This fleet merges engine changes far more often
# than every 45 minutes, so NOW was permanently less than DEADLINE and the
# alarm/dispatch branch below was unreachable. A busy repo muted its own
# staleness alarm, and the busier it got the quieter it became.
#
# The honest anchor is the OLDEST engine commit production does not have: the
# moment it actually fell behind. That instant does not move when someone
# merges again, so the grace is spent once rather than renewed forever.
#
# REQ_SHORT stays the thing we ask FOR (the newest commit, what main needs) -
# only the clock changes.
BEHIND_SINCE_EPOCH=$REQ_EPOCH
if [ -n "${SERVED:-}" ] && git cat-file -e "${SERVED}^{commit}" 2>/dev/null; then
  FIRST_UNSHIPPED=$(git log --reverse --format=%H "${SERVED}..origin/main" -- \
    'server/**' ':(exclude)server/**/*.test.ts' ':(exclude)server/sim/**' 2>/dev/null | head -1)
  if [ -n "${FIRST_UNSHIPPED:-}" ]; then
    BEHIND_SINCE_EPOCH=$(git show -s --format=%ct "$FIRST_UNSHIPPED")
    say "behind since: $(git show -s --format=%cI "$FIRST_UNSHIPPED") ($(( ( NOW_EPOCH - BEHIND_SINCE_EPOCH ) / 60 ))m), first engine commit the engine does not have"
  fi
else
  # Cannot resolve what production serves, so we cannot tell when it fell
  # behind. Fall back to the old anchor: quieter, never louder.
  say "cannot resolve the served commit locally - holding the grace against $REQ_SHORT as before"
fi

WINDOW_EPOCH=$(window_at_or_after "$BEHIND_SINCE_EPOCH")
WINDOW_START=$(( WINDOW_EPOCH > BEHIND_SINCE_EPOCH ? WINDOW_EPOCH : BEHIND_SINCE_EPOCH ))
DEADLINE=$(( WINDOW_START + DEPLOY_MIN * 60 ))
GRACE_DEADLINE=$(( BEHIND_SINCE_EPOCH + GRACE_MIN * 60 ))
[ "$GRACE_DEADLINE" -gt "$DEADLINE" ] && DEADLINE=$GRACE_DEADLINE
WINDOW_LOCAL=$(chicago_stamp "$WINDOW_EPOCH")

if [ "$NOW_EPOCH" -lt "$DEADLINE" ]; then
  say "Behind by design: the engine restarts in the :${RESTART_MINUTE} break."
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

# ── 5. Behind for too long. Say so - and never try to fix it from here. ─────
say "::warning title=ENGINE BEHIND::$REQ_SHORT has been on main for ${AGE_MIN}m and the engine still serves $SERVED."

# ── THIS WATCHDOG NO LONGER DISPATCHES DEPLOYS (2026-09-10) ─────────────────
#
# Dan, 2026-09-10: "i do not want any watch dogs, i want hard coded fixes that
# solve this problem and prevent it from breaking or regressing, i want any
# and all pushes to be published in the order that they come in!"
#
# This block used to `gh workflow run` the deploy whenever the engine was
# behind and no run was in flight, and on 2026-09-10 it was the thing that
# started nearly every deploy: GitHub delivered 3 of ~19 of the deploy's
# hourly cron ticks. That made a watchdog the primary trigger - a band-aid
# that had grown its own history of incidents (2026-09-09: every sweep's
# dispatch cancelled the run waiting in the break gate, three hours behind).
#
# The trigger is structural now, inside auto-deploy-hetzner.yml: every engine
# push starts a run, a superseded run hands the train to current main, and a
# run its break gate could not serve dispatches its successor. So what is left
# for this script is to SAY that the chain has stopped - which it has, if we
# get here: a run failed (tests, build, a cutover that rolled back) and no fix
# has been pushed since, or a hand-on dispatch was refused. Both need a
# person; neither is repaired by one more dispatch of the same commit.
#
# It still reports whether a run is in flight, because "behind, and a run is
# waiting for the next break" and "behind, and nothing is coming" are
# different pages. A run's age is measured from createdAt, which INCLUDES the
# time it spent pending behind another one, so a run can be legitimately in
# flight for two full ceilings (timeout-minutes 130): 2 x 130 + 10.
# tests/the-deploy-can-always-ship.law.test.ts derives this from the ceiling.
NOW_TS=$(date -u +%s)
NEXT_WINDOW_EPOCH=$(window_at_or_after "$NOW_TS")
NEXT_WINDOW_LOCAL=$(chicago_stamp "$NEXT_WINDOW_EPOCH")
MINS_TO_WINDOW=$(( (NEXT_WINDOW_EPOCH - NOW_TS) / 60 ))
INFLIGHT_STALE_MIN=${INFLIGHT_STALE_MIN:-270}
INFLIGHT=$(gh run list --repo "$REPO" --workflow "$DEPLOY_WORKFLOW" --limit 20 \
  --json databaseId,status,createdAt,headSha,event,url \
  --jq "[.[] | select(.status != \"completed\")
          | select((now - (.createdAt | fromdateiso8601)) < (${INFLIGHT_STALE_MIN} * 60))]
        | .[0] // empty
        | \"\\(.databaseId) \\(.status) \\(.headSha[0:8]) \\(.event) \\(((now - (.createdAt | fromdateiso8601)) / 60) | floor)m \\(.url)\"" \
  2>/dev/null || echo "")
if [ -n "${INFLIGHT:-}" ]; then
  DISPATCHED="no - this watchdog only reports. A deploy run is in flight ($INFLIGHT) and waits in its break gate for the next :${RESTART_MINUTE} (${NEXT_WINDOW_LOCAL}, ${MINS_TO_WINDOW}m away)."
  say "  a deploy run is in flight ($INFLIGHT); the break at $NEXT_WINDOW_LOCAL is ${MINS_TO_WINDOW}m away"
else
  DISPATCHED="no - this watchdog only reports, and NO deploy run is in flight: the train has stopped. Read the last deploy run's Verdict; push the fix, or dispatch $DEPLOY_WORKFLOW on main by hand once the cause is understood."
  say "::error title=DEPLOY TRAIN STOPPED::the engine is behind and no deploy run is in flight. Nothing will start one until a fix is pushed or someone dispatches $DEPLOY_WORKFLOW on main."
fi

# ── THE PIPELINE'S OWN ACCOUNT OF WHY (2026-09-05) ──────────────────────────
# Staleness says the engine is behind. It has never said WHY, and the answer
# has been sitting in ca_engine_deploy_attempts the whole time - 52 of 98
# attempts over the three days to 2026-09-05 reported success having shipped
# nothing, each with a recorded reason nobody was reading. Pasting that table
# into the issue turns two hours of reading the ledger by hand into the first
# thing the next person sees. Best-effort by design: no DATABASE_URL, no pg,
# no rows, and $LEDGER is simply empty. A watchdog must never fail because its
# optional evidence was unavailable.
LEDGER=""
if [ -n "${DATABASE_URL:-}" ]; then
  npm ls pg >/dev/null 2>&1 || npm i pg@8 --no-save --no-audit --no-fund >/dev/null 2>&1 || true
  LEDGER=$(node "$(dirname "$0")/deploy-ship-rate.mjs" 2>/dev/null || echo "")
fi

BODY=$(cat <<EOF
The engine is not running main.

| | |
| --- | --- |
| main needs | \`$REQ_SHORT\` ($REQ_TIME, **${AGE_MIN}m** ago) |
| engine serves | \`$SERVED\` |
| deploy in flight | $DISPATCHED |
| next restart window | $NEXT_WINDOW_LOCAL |

\`$REQ_SHORT\` is the newest commit touching the engine runtime, excluding tests
and sim, which never enter the image.

**A merge starts a deploy; the deploy restarts only in the break.** Every
engine push starts a run of \`auto-deploy-hetzner.yml\`, and that run waits in
its break gate until the engine parks every table at :${RESTART_MINUTE}. So being
behind for part of an hour is normal and this watchdog stays silent for it.
Seeing this issue at all means a break has already opened since the commit and
passed without the engine catching up.

**This watchdog reports; it does not dispatch** (Dan, 2026-09-10: no watchdogs).
The train hands itself on inside the workflow - a superseded run dispatches
current main, and a run its break gate could not serve dispatches its
successor - so an engine that stays behind means a run FAILED (tests, build,
or a cutover that rolled back) and nothing has been pushed since, or a hand-on
dispatch was refused. The Verdict step of that run names which.

$LEDGER

**If this is still open on the next sweep**, the deploy is being refused rather
than deferred, and the table above says by which gate. Every run also records
its own reason in \`ca_engine_deploy_attempts\` and prints it under the step
named \`DID NOT DEPLOY\`, so start there rather than reading the whole log.

This issue closes itself when the engine catches up.
EOF
)

EXISTING=$(find_issue "$ISSUE_TITLE")
if [ -n "${EXISTING:-}" ]; then
  # One progress comment per COMMENT_EVERY_MIN, not one per sweep. This job
  # runs on every publisher completion; on 2026-09-09 that was a "Still
  # behind" comment every few minutes for three hours, and the reader who
  # opened the issue had to scroll past forty of them to find the table that
  # says why. A comment that says nothing new is noise on the alarm.
  COMMENT_EVERY_MIN=${COMMENT_EVERY_MIN:-30}
  LAST_COMMENT_AGE_MIN=$(GH_TOKEN="${GH_TOKEN_ISSUES:-${GH_TOKEN:-}}" \
    gh issue view "$EXISTING" --repo "$REPO" --json comments,createdAt \
      --jq '((now - ((.comments | last | .createdAt) // .createdAt | fromdateiso8601)) / 60) | floor' \
      2>/dev/null || echo "")
  if [ -n "${LAST_COMMENT_AGE_MIN:-}" ] && [ "$LAST_COMMENT_AGE_MIN" -lt "$COMMENT_EVERY_MIN" ]; then
    say "  #$EXISTING already says so (last comment ${LAST_COMMENT_AGE_MIN}m ago, < ${COMMENT_EVERY_MIN}m) - not commenting again"
  else
    gh_write "comment on #$EXISTING" issue comment "$EXISTING" --repo "$REPO" \
      --body "Still behind. main needs \`$REQ_SHORT\` (${AGE_MIN}m old); the engine serves \`$SERVED\`. Deploy in flight: $DISPATCHED." || true
  fi
else
  gh_write "open an issue" issue create --repo "$REPO" --title "$ISSUE_TITLE" --body "$BODY" || true
fi

summary "### Engine watchdog: BEHIND"
summary ""
summary "main needs \`$REQ_SHORT\` (${AGE_MIN}m old); the engine serves \`$SERVED\`. Deploy in flight: $DISPATCHED."

# The alarm is raised. Failing the job as well
# would turn every deferred restart into a red workflow that nobody can act on
# faster than the watchdog already has.
exit 0
