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
ISSUE_TITLE="Engine watchdog: production is not running main"

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

# ── 4. Behind, but recently ─────────────────────────────────────────────────
if [ "$AGE_MIN" -lt "$GRACE_MIN" ]; then
  say "Behind by design so far: $REQ_SHORT is ${AGE_MIN}m old, inside the ${GRACE_MIN}m grace window."
  summary "### Engine watchdog: catching up"
  summary ""
  summary "\`$REQ_SHORT\` is ${AGE_MIN}m old and the engine serves \`$SERVED\`. A coalesced restart or a drain-gate deferral is normal here; the \`*/20\` catch-up has not run out of chances yet."
  exit 0
fi

# ── 5. Behind for too long. Fix it, then say so. ────────────────────────────
say "::warning title=ENGINE BEHIND::$REQ_SHORT has been on main for ${AGE_MIN}m and the engine still serves $SERVED."

DISPATCHED="no"
if gh workflow run "$DEPLOY_WORKFLOW" --repo "$REPO" --ref main >/dev/null 2>&1; then
  DISPATCHED="yes"
  say "  dispatched $DEPLOY_WORKFLOW on main"
else
  say "::error::could not dispatch $DEPLOY_WORKFLOW -- the engine is behind and this run could not even try to fix it."
fi

BODY=$(cat <<EOF
The engine is not running main.

| | |
| --- | --- |
| main needs | \`$REQ_SHORT\` ($REQ_TIME, **${AGE_MIN}m** ago) |
| engine serves | \`$SERVED\` |
| deploy dispatched by this run | $DISPATCHED |

\`$REQ_SHORT\` is the newest commit touching the engine runtime, excluding tests
and sim, which never enter the image.

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
