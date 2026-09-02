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
# not one. Kept as a function because the dispatch decision below reads better
# for it, and because a future rationing change has one place to go.
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
    --json conclusion,status,url,databaseId \
    --jq '[.[] | select(.status=="completed" and .conclusion!="cancelled")] | .[0:2]' 2>/dev/null || echo "")
  latest=$(printf '%s' "$RUNS" | jq -r '.[0].conclusion // "none"' 2>/dev/null || echo none)
  prev=$(printf '%s' "$RUNS" | jq -r '.[1].conclusion // "none"' 2>/dev/null || echo none)
  url=$(printf '%s' "$RUNS" | jq -r '.[0].url // ""' 2>/dev/null || echo "")
  if [ "$latest" = "failure" ] && [ "$prev" = "failure" ]; then
    rid=$(printf '%s' "$RUNS" | jq -r '.[0].databaseId // ""' 2>/dev/null || echo "")
    step=$(gh run view "$rid" --repo "$REPO" --json jobs \
      --jq '[.jobs[].steps[] | select(.conclusion=="failure")][0].name // "unknown step"' 2>/dev/null || echo "unknown step")
    say "::warning title=DEPLOY TRAIN FAILING::the last two completed deploy runs failed. Latest failing step: $step"
    n=$(find_issue "$TRAIN_TITLE")
    if [ -n "${n:-}" ]; then
      gh_write "comment on #$n" issue comment "$n" --repo "$REPO" \
        --body "Still failing. Latest failing step: **$step**. $url" || true
    else
      gh_write "open the train issue" issue create --repo "$REPO" --title "$TRAIN_TITLE" --body "The last two completed (non-cancelled) runs of \`$DEPLOY_WORKFLOW\` FAILED.

| | |
| --- | --- |
| latest failing step | **$step** |
| latest run | $url |

A failing train strands every merge whether or not the engine is currently behind. On 2026-09-02 main went red on a migrations-only merge while nothing server-touching was queued: the staleness alarm had nothing to say, and every window for the next three hours was already lost. Start at the failing step above - it is the gate that is refusing, and the gate is usually right (fix main, never the gate).

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
# Every hour is a restart window now, but the deploy's break gate only polls
# for about 14 minutes before giving up with BREAK NEVER OPENED. A dispatch at
# :10 therefore burns a runner for a quarter of an hour and provably ships
# nothing - and an alarm claiming "a retry has been dispatched" when the retry
# cannot work is worse than one that says nothing. Dispatch only when the next
# :55 is close enough that the run will still be alive and waiting when the
# break opens; otherwise say when the window comes and let the deploy's own
# :40/:45/:50 crons take it.
MINS_TO_WINDOW=$(( (NEXT_WINDOW_EPOCH - NOW_TS) / 60 ))
if [ "$MINS_TO_WINDOW" -le 13 ]; then
  if gh workflow run "$DEPLOY_WORKFLOW" --repo "$REPO" --ref main >/dev/null 2>&1; then
    DISPATCHED="yes"
    say "  dispatched $DEPLOY_WORKFLOW on main (${MINS_TO_WINDOW}m to the break)"
  else
    say "::error::could not dispatch $DEPLOY_WORKFLOW -- the engine is behind and this run could not even try to fix it."
  fi
else
  DISPATCHED="no - the break at $NEXT_WINDOW_LOCAL is ${MINS_TO_WINDOW}m away, past the deploy's 14-minute wait budget"
  say "  not dispatching: the break gate would give up before $NEXT_WINDOW_LOCAL. The deploy's own :40/:45/:50 crons cover that window."
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

**The engine restarts on a schedule, not on a merge.** Since #2527 it restarts
every hour inside the announced break at :${RESTART_MINUTE}, so being behind
for part of an hour is normal and this watchdog stays silent for it. Seeing
this issue at all means a break has already opened since the commit and passed
without the engine catching up.

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
