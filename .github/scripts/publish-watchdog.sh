#!/usr/bin/env bash
# DID THE MERGE ACTUALLY REACH PRODUCTION?
#
# Everything else in this repo watches whether code MERGES. Nothing watched
# whether it PUBLISHED, and that is the gap every "it worked, then it regressed
# hours later" report has fallen through:
#
#   * a PR that touched .github/workflows/ merged, the bundle built, and the
#     sync push was rejected because a GitHub App may not write workflow files.
#     Red run, nobody looking, production served the previous build for hours;
#   * `cancel-in-progress: true` killed every build before its sync step, so
#     production sat on 7547a6e45 while main ran far ahead;
#   * three syncs published a bundle built from a stale tree while naming the
#     current sha in the commit message.
#
# In all three the merge was green, the agent reported success, and production
# was stale. The only thing that can tell them apart is asking PRODUCTION what
# it is serving and comparing it to main. That is this script.
#
# It is also self-healing: a lag with no successful build for HEAD gets ONE
# automatic re-dispatch before a human is told, because the common causes
# (a cancelled run, a rejected push, a transient 5xx) are all fixed by running
# it again.
#
# Env: GH_TOKEN, GITHUB_REPOSITORY. Optional: LAG_BUDGET_MIN (default 25).
set -uo pipefail

REPO="${GITHUB_REPOSITORY:?}"
BUILD_INFO_URL="${BUILD_INFO_URL:-https://smarter.poker/hub/club-arena/build-info.json}"
PUBLISH_WORKFLOW="${PUBLISH_WORKFLOW:-build-for-world-hub.yml}"
LAG_BUDGET_MIN="${LAG_BUDGET_MIN:-25}"
ISSUE_TITLE="Publish watchdog: production is not serving main"

say() { echo "$@"; }
summary() { echo "$@" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"; }

# ── ESCALATION OF LAST RESORT (added 2026-09-02) ───────────────────────────
# Automatic healing cannot be unconditional. If the bundle genuinely does not
# build, the right outcome is NOT to ship it anyway - shipping a broken client
# to every player is worse than lagging. So the guarantee this watchdog can
# actually make is: nothing pending is ever silently forgotten.
#
# Which means that when the retries are spent, the alarm has to reach a person
# rather than a repository. A GitHub issue is a place Dan does not live; the
# in-app notification is. This mirrors estate-digest.mjs, which delivers to the
# same recipient list.
#
# Silent no-op when the credentials are absent, so this can never be the reason
# a watchdog run fails.
escalate_in_app() {
  [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ] || {
    say "no Supabase credentials in this run - skipping the in-app escalation."
    return 0
  }
  RECIPS=$(curl -fsS --max-time 20 \
    "${SUPABASE_URL}/rest/v1/ca_incident_recipients?scope=eq.platform&active=eq.true&select=user_id" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" 2>/dev/null \
    | jq -r '.[].user_id' 2>/dev/null | sort -u || echo "")
  [ -n "$RECIPS" ] || { say "no active platform recipients - in-app escalation has nobody to reach."; return 0; }

  SENT=0
  # NOT `UID`. It is readonly in bash, so `for UID in ...` aborts the function
  # with exit 127 - caught by executing this against a stub rather than by
  # reading it, which is the whole reason the escalation is behaviour-tested.
  for RECIP in $RECIPS; do
    # Title Case, no em dashes: house popup rules (CLAUDE.md 5.7).
    if curl -fsS --max-time 20 -X POST "${SUPABASE_URL}/rest/v1/rpc/fn_raise_notification" \
        -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
        -H "authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
        -H 'content-type: application/json' \
        -d "$(jq -n --arg u "$RECIP" --arg m "$1" '{
              p_user_id:$u,
              p_type:"publish_stranded",
              p_title:"Publish Needs A Human",
              p_message:$m,
              p_link:"/hub/club-arena/",
              p_data:{source:"publish-watchdog.sh"}
            }')" >/dev/null 2>&1; then
      SENT=$((SENT + 1))
    fi
  done
  say "in-app escalation delivered to ${SENT} recipient(s)."
}

# A watchdog whose alarm fails silently is not a watchdog. Every write here
# goes through this: `gh ... >/dev/null 2>&1 && say "opened an issue"` prints
# nothing at all when the write fails, which is how report-stuck-prs.sh found
# six stranded pull requests in PepNationLab, could not raise the issue, and
# logged 53 seconds of silence on a step that reported success.
# ISSUE WRITES USE A DIFFERENT TOKEN ON PURPOSE. The App installation token is
# required for MERGES, because a merge made with GITHUB_TOKEN does not trigger
# downstream workflows and the commit would land without publishing. Raising an
# issue has no downstream effect at all, so it does not need the App - and
# GITHUB_TOKEN, with `issues: write` declared in the workflow, is guaranteed to
# have the permission, where an App's installation scopes can be narrowed
# without anyone here noticing. Use the narrow token for the narrow job.
# FIND THE EXISTING ISSUE WITHOUT USING SEARCH.
#
# `gh issue list --search "<title> in:title"` reads GitHub's SEARCH INDEX, which
# is eventually consistent - a freshly created issue is not findable for a
# minute or two. Two sweeps 87 seconds apart both looked, both saw nothing, and
# both created one: PepNationLab #79 and #80, same title, same content. A
# de-duplicating guard that duplicates is worse than none, because the noise
# teaches people to ignore it.
#
# The plain list endpoint is not an index. It is current.
find_issue() {
  # SAME TOKEN AS THE WRITE, and that is not a tidiness point. This read used
  # plain $GH_TOKEN - the App installation token - while the write used
  # GH_TOKEN_ISSUES. The App has no issues scope here, so the read returned
  # nothing every time, the guard concluded there was no existing issue, and
  # filed another one. World Hub #633, #637, #638 and PepNationLab #79, #81,
  # #83 are that bug: a read and a write that disagreed about who they were.
  GH_TOKEN="${GH_TOKEN_ISSUES:-${GH_TOKEN:-}}" \
  gh issue list --repo "${REPO:-$GITHUB_REPOSITORY}" --state open --limit 100 --json number,title \
    --jq "[.[] | select(.title == \"$1\")] | .[0].number // empty" 2>/dev/null
}

gh_write() {
  local what="$1"; shift
  local out
  if out=$(GH_TOKEN="${GH_TOKEN_ISSUES:-${GH_TOKEN:-}}" gh "$@" 2>&1); then
    say "  $what"
    return 0
  fi
  say "::error::publish-watchdog could not $what -- production is behind and nobody was told."
  printf '%s\n' "$out" | sed 's/^/    /'
  return 1
}

HEAD_SHA=$(git rev-parse HEAD)
HEAD_SHORT=${HEAD_SHA:0:8}
HEAD_TIME=$(git show -s --format=%cI "$HEAD_SHA")
HEAD_EPOCH=$(git show -s --format=%ct "$HEAD_SHA")
NOW=$(date -u +%s)
AGE_MIN=$(( (NOW - HEAD_EPOCH) / 60 ))

# Cache-bust. A CDN-cached answer is worse than no answer: it is a stale fact
# wearing a fresh timestamp, and this whole script exists to stop exactly that.
SERVED_JSON=$(curl -fsSL -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
                "${BUILD_INFO_URL}?cb=${NOW}" 2>/dev/null || true)

if [ -z "$SERVED_JSON" ]; then
  say "::error::could not read $BUILD_INFO_URL — production is unreachable or the bundle has no provenance file."
  SERVED_SHA=""
else
  SERVED_SHA=$(printf '%s' "$SERVED_JSON" | sed -n 's/.*"ca_sha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
fi
SERVED_SHORT=${SERVED_SHA:0:8}

say "main HEAD : $HEAD_SHORT ($HEAD_TIME, ${AGE_MIN}m ago)"
say "production: ${SERVED_SHORT:-<unreadable>}"

close_issue() {
  N=$(find_issue "$ISSUE_TITLE")
  [ -n "${N:-}" ] || return 0
  gh_write "comment on #$N" issue comment "$N" --repo "$REPO" \
    --body "Recovered. Production is serving \`$HEAD_SHORT\`, which is main's HEAD. Closing." || true
  gh_write "close issue #$N (production caught up)" issue close "$N" --repo "$REPO" || true
}

# ── Healthy ────────────────────────────────────────────────────────────────
if [ "$SERVED_SHA" = "$HEAD_SHA" ]; then
  say "OK — production is serving main."
  summary "### Publish watchdog: OK"
  summary ""
  summary "Production serves \`$HEAD_SHORT\`, which is main's HEAD."
  close_issue
  exit 0
fi

# ── Serving something that is NOT on main at all ───────────────────────────
# This is the dangerous one and nothing looked for it before. A rewound main,
# a force-push, or a sync that published from a branch all land here, and none
# of them are "lag" — waiting does not fix them.
if [ -n "$SERVED_SHA" ] && ! git merge-base --is-ancestor "$SERVED_SHA" "$HEAD_SHA" 2>/dev/null; then
  say "::error::production is serving $SERVED_SHORT, which is NOT an ancestor of main."
  DIAG="Production is serving \`$SERVED_SHORT\`, and that commit **is not on main**.

This is not publish lag — lag means production is serving an older commit that is still an ancestor of main, and it resolves itself. A non-ancestor means one of:

- main was rewound or force-pushed after that bundle published;
- the bundle was published from a branch rather than from main;
- the commit was never fetched here (this job checks out with \`fetch-depth: 0\`, so that is unlikely).

Nothing will fix this on its own. Find out which of the three it is before pushing anything else."
  NOT_ANCESTOR=1
else
  NOT_ANCESTOR=0
  say "production is behind main (lag), serving ${SERVED_SHORT:-nothing readable}."
fi

# ── Inside the budget: a build is probably still in flight ─────────────────
if [ "$NOT_ANCESTOR" = "0" ] && [ "$AGE_MIN" -lt "$LAG_BUDGET_MIN" ]; then
  say "main's HEAD is only ${AGE_MIN}m old and the budget is ${LAG_BUDGET_MIN}m — a build is probably still running. Not alarming."
  # This state IS recovery. The healthy path above closes the alarm only on
  # serving EXACTLY head, and on a main that merges every few minutes that
  # moment never coincides with a sweep - so issue #2566 sat open for hours
  # after the non-ancestor anomaly it described had resolved, teaching
  # everyone the alarm means nothing. Ancestor lag within budget means the
  # conditions that file the issue (non-ancestor, or over-budget) are gone.
  N=$(find_issue "$ISSUE_TITLE")
  if [ -n "${N:-}" ]; then
    gh_write "comment on #$N" issue comment "$N" --repo "$REPO" \
      --body "Recovered. Production is serving \`${SERVED_SHORT:-?}\`, an ancestor of main, ${AGE_MIN}m inside the ${LAG_BUDGET_MIN}m budget - ordinary publish lag, resolving itself. Closing." || true
    gh_write "close issue #$N (recovered to ordinary lag)" issue close "$N" --repo "$REPO" || true
  fi
  summary "### Publish watchdog: in flight"
  summary ""
  summary "main \`$HEAD_SHORT\` is ${AGE_MIN}m old; production serves \`${SERVED_SHORT:-?}\`. Within the ${LAG_BUDGET_MIN}m budget."
  exit 0
fi

# ── Over budget. What did the publish workflow actually do for this sha? ────
RUN=$(gh run list --repo "$REPO" --workflow "$PUBLISH_WORKFLOW" --limit 30 \
        --json databaseId,headSha,status,conclusion,event,url \
        --jq "[.[] | select(.headSha == \"$HEAD_SHA\")] | .[0]" 2>/dev/null || echo "")
RUN_STATUS=$(printf '%s' "$RUN" | jq -r '.status // "none"' 2>/dev/null || echo none)
RUN_CONCL=$(printf '%s' "$RUN"  | jq -r '.conclusion // "none"' 2>/dev/null || echo none)
RUN_URL=$(printf '%s' "$RUN"    | jq -r '.url // ""' 2>/dev/null || echo "")
RUN_EVENT=$(printf '%s' "$RUN"  | jq -r '.event // ""' 2>/dev/null || echo "")
say "publish run for $HEAD_SHORT: status=$RUN_STATUS conclusion=$RUN_CONCL event=$RUN_EVENT"

if [ "$RUN_STATUS" = "in_progress" ] || [ "$RUN_STATUS" = "queued" ]; then
  say "a publish run for this sha is still $RUN_STATUS — letting it finish."
  exit 0
fi

# ── Self-heal, up to MAX_RETRIES per sha ───────────────────────────────────
# The failures that strand a publish are overwhelmingly transient (a cancelled
# run, a rejected push, a 5xx, a runner outage). Re-running fixes those without
# a human. The cap exists so a GENUINELY broken build cannot be dispatched
# forever — it is a stop on noise, not a stop on healing.
#
# 2026-09-02 — TWO CORRECTIONS, both of which stranded real commits:
#
#   1. The cap was ONE. A single transient failure followed by a second
#      unrelated one meant the watchdog gave up and only filed an issue, so
#      main sat unpublished until a human dispatched by hand. That is the
#      "my last 3 pushes have not published" report. The cap is 3 now.
#
#   2. A CANCELLED retry counted against the cap. A cancellation carries no
#      information about brokenness — it means a newer push superseded the
#      run, which is the publisher working correctly. Burning the one retry on
#      it was how a healthy repo talked itself out of healing. Cancelled and
#      skipped attempts are no longer counted; only attempts that actually ran
#      to a verdict are evidence of a fault.
#
# Retrying is also cheap and safe now: the publisher resolves the tip of main
# itself, so a dispatch converges the whole backlog, and its dedupe makes an
# already-current cycle one curl.
MAX_RETRIES="${MAX_RETRIES:-3}"
ALREADY_RETRIED=$(gh run list --repo "$REPO" --workflow "$PUBLISH_WORKFLOW" \
                    --event workflow_dispatch --limit 30 --json headSha,conclusion \
                    --jq "[.[]
                           | select(.headSha == \"$HEAD_SHA\")
                           | select(.conclusion != \"cancelled\")
                           | select(.conclusion != \"skipped\")] | length" 2>/dev/null || echo 0)

RETRY_NOTE=""
if [ "$NOT_ANCESTOR" = "0" ] && [ "${ALREADY_RETRIED:-0}" -lt "$MAX_RETRIES" ]; then
  ATTEMPT=$((ALREADY_RETRIED + 1))
  if gh workflow run "$PUBLISH_WORKFLOW" --repo "$REPO" --ref main >/dev/null 2>&1; then
    say "re-dispatched $PUBLISH_WORKFLOW for main — automatic retry ${ATTEMPT} of ${MAX_RETRIES}."
    RETRY_NOTE="

**Automatic retry ${ATTEMPT} of ${MAX_RETRIES} has been dispatched.** The publisher converges on the tip of \`main\`, so this retry ships every pending commit, not just this one. If retries run out and production is still behind, the cause is not transient and this issue will say so."
  else
    RETRY_NOTE="

An automatic retry was attempted and the dispatch itself failed — check the token's \`actions: write\`."
  fi
elif [ "${ALREADY_RETRIED:-0}" -ge "$MAX_RETRIES" ]; then
  RETRY_NOTE="

All ${MAX_RETRIES} automatic retries are used for this sha and production is still behind, so the cause is not transient. Read the publish run before dispatching another. (Cancelled attempts are not counted — every one of these ran to a verdict and did not fix it.)"
  # Healing is spent and the build is genuinely broken. Auto-shipping it would
  # be worse than lagging, so this is the point where a person has to know.
  escalate_in_app "Main \`${HEAD_SHORT}\` Is ${AGE_MIN} Minutes Old And Production Still Serves \`${SERVED_SHORT:-Unknown}\`. ${MAX_RETRIES} Automatic Retries Are Spent, So This Needs A Human."
fi

BODY="Production is not serving main, and it is past the ${LAG_BUDGET_MIN}-minute budget.

| | |
|---|---|
| main HEAD | \`$HEAD_SHORT\` — $HEAD_TIME (${AGE_MIN}m ago) |
| production serving | \`${SERVED_SHORT:-unreadable}\` |
| publish run for HEAD | ${RUN_STATUS}/${RUN_CONCL} ${RUN_URL} |

${DIAG:-A merge that does not publish is indistinguishable from a regression: main moves, agents report success, and users keep seeing the previous build. That is the failure this watchdog exists to name.}

**Where to look, in order**

1. The publish run above. \`Client tests must pass before the bundle ships\` and the World Hub push are the two steps that fail most.
2. \`gh run list --repo Smarter-Poker/Smarter-Poker-World-Hub --limit 5\` — the bundle can reach World Hub and still not deploy.
3. \`curl -s $BUILD_INFO_URL\` — the authoritative answer to what is live.${RETRY_NOTE}

_Raised automatically by \`.github/workflows/publish-watchdog.yml\`. It closes itself when production catches up._"

EXISTING=$(find_issue "$ISSUE_TITLE")
if [ -n "${EXISTING:-}" ]; then
  gh_write "update issue #$EXISTING" issue comment "$EXISTING" --repo "$REPO" --body "$BODY" || true
else
  gh_write "open an issue" issue create --repo "$REPO" --title "$ISSUE_TITLE" --body "$BODY" || true
fi

summary "### Publish watchdog: PRODUCTION IS BEHIND"
summary ""
summary "main \`$HEAD_SHORT\` (${AGE_MIN}m old) vs production \`${SERVED_SHORT:-?}\`."

# Exit non-zero so the run is red and shows up in the Actions list, not just in
# an issue nobody has subscribed to.
exit 1
