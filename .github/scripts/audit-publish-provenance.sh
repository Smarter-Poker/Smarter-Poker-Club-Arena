#!/usr/bin/env bash
# Read-only proof that the public Club Arena bundle is either exact protected
# main or still inside the declared publication budget. This script cannot
# publish, retry, dispatch, open/close issues, or mutate production.
set -euo pipefail

REPO="${GITHUB_REPOSITORY:?}"
BUILD_INFO_URL="${BUILD_INFO_URL:-https://smarter.poker/hub/club-arena/build-info.json}"
PUBLISH_WORKFLOW="${PUBLISH_WORKFLOW:-publish-club-arena.yml}"
LAG_BUDGET_MIN="${LAG_BUDGET_MIN:-25}"

say() { printf '%s\n' "$*"; }
summary() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"
}

HEAD_SHA=$(git rev-parse HEAD)
HEAD_SHORT=${HEAD_SHA:0:8}
HEAD_TIME=$(git show -s --format=%cI "$HEAD_SHA")
HEAD_EPOCH=$(git show -s --format=%ct "$HEAD_SHA")
NOW=$(date -u +%s)
AGE_MIN=$(( (NOW - HEAD_EPOCH) / 60 ))

SERVED_JSON=$(curl -fsSL --max-time 15 \
  -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
  "${BUILD_INFO_URL}?cb=${NOW}" 2>/dev/null || true)
SERVED_SHA=$(printf '%s' "$SERVED_JSON" | node -e '
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { body += chunk; });
  process.stdin.on("end", () => {
    try {
      const value = JSON.parse(body).ca_sha;
      process.stdout.write(typeof value === "string" ? value : "");
    } catch {}
  });
' 2>/dev/null || true)

say "main HEAD : $HEAD_SHORT ($HEAD_TIME, ${AGE_MIN}m ago)"
say "production: ${SERVED_SHA:-<unreadable exact identity>}"

if ! [[ "$SERVED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  say "::error title=CLIENT PROVENANCE UNKNOWN::$BUILD_INFO_URL did not return one exact Club Arena SHA."
  summary '### Client release provenance: UNKNOWN'
  summary ''
  summary 'The public Club Arena build did not return one exact immutable SHA.'
  exit 1
fi

if [ "$SERVED_SHA" = "$HEAD_SHA" ]; then
  say 'OK — production is serving exact protected main.'
  summary '### Client release provenance: OK'
  summary ''
  summary "Production serves exact main SHA \`$HEAD_SHA\`."
  exit 0
fi

if ! git cat-file -e "${SERVED_SHA}^{commit}" 2>/dev/null || \
   ! git merge-base --is-ancestor "$SERVED_SHA" "$HEAD_SHA"; then
  say "::error title=CLIENT PROVENANCE MISMATCH::Production serves $SERVED_SHA, which is not contained in protected main $HEAD_SHA."
  summary '### Client release provenance: NON-MAIN BUILD'
  summary ''
  summary "Production serves \`$SERVED_SHA\`, which is not contained in main \`$HEAD_SHA\`."
  exit 1
fi

if [ "$AGE_MIN" -lt "$LAG_BUDGET_MIN" ]; then
  say "IN FLIGHT — main is ${AGE_MIN}m old, inside the ${LAG_BUDGET_MIN}m publication budget."
  summary '### Client release provenance: IN FLIGHT'
  summary ''
  summary "Production serves ancestor \`$SERVED_SHA\`; main is ${AGE_MIN}m old and inside budget."
  exit 0
fi

# Workflow state is diagnostic evidence only. It never authorizes a retry.
RUN=$(gh run list --repo "$REPO" --workflow "$PUBLISH_WORKFLOW" --limit 30 \
  --json headSha,status,conclusion,url \
  --jq "[.[] | select(.headSha == \"$HEAD_SHA\")][0] // {}" 2>/dev/null || printf '{}')
RUN_STATUS=$(printf '%s' "$RUN" | jq -r '.status // "none"')
RUN_CONCLUSION=$(printf '%s' "$RUN" | jq -r '.conclusion // "none"')
RUN_URL=$(printf '%s' "$RUN" | jq -r '.url // ""')

say "::error title=CLIENT RELEASE BEHIND::Production still serves $SERVED_SHA after the ${LAG_BUDGET_MIN}m budget; publish run is $RUN_STATUS/$RUN_CONCLUSION."
summary '### Client release provenance: BEHIND'
summary ''
summary "Main: \`$HEAD_SHA\`"
summary "Production: \`$SERVED_SHA\`"
summary "Publish run: ${RUN_STATUS}/${RUN_CONCLUSION} ${RUN_URL}"
exit 1
