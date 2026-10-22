#!/usr/bin/env bash
# Read-only proof that the Hetzner Club Arena engine contains the newest
# protected-main engine change. Delivery belongs exclusively to
# stage-engine-release.yml -> auto-deploy-hetzner.yml. This audit never waits,
# dispatches, retries, opens issues, or edits production.
set -euo pipefail

ENGINE_URL="${ENGINE_URL:-https://engine.smarter.poker}"

say() { printf '%s\n' "$*"; }
summary() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"
}

# Test-only, simulation-only and local-qualification changes do not alter
# production behavior, so the required identity is the newest protected-main
# runtime-affecting commit.
REQ_SHA=$(git log origin/main -1 --format=%H -- \
  'server/**' ':(exclude)server/**/*.test.ts' ':(exclude)server/sim/**' ':(exclude)server/qualification/**')

if ! [[ "$REQ_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  say '::error title=ENGINE PROVENANCE UNKNOWN::Could not resolve one full engine-affecting SHA from protected main.'
  summary '### Engine provenance: UNKNOWN'
  summary ''
  summary 'The required protected-main engine SHA could not be resolved.'
  exit 1
fi

REQ_SHORT=${REQ_SHA:0:8}
REQ_TIME=$(git show -s --format=%cI "$REQ_SHA")

# Cache-busting headers prevent a stale health document from masquerading as
# current evidence. An unreadable or malformed response is UNKNOWN, never OK.
HEALTH=$(curl -fsSL --max-time 15 \
  -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
  "$ENGINE_URL/health" 2>/dev/null || true)
SERVED=$(printf '%s' "$HEALTH" | node -e '
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { body += chunk; });
  process.stdin.on("end", () => {
    try {
      const value = JSON.parse(body).releaseSha;
      process.stdout.write(typeof value === "string" ? value : "");
    } catch {}
  });
' 2>/dev/null || true)

say "main needs : $REQ_SHORT ($REQ_TIME)"
say "engine has : ${SERVED:-<unreadable exact identity>}"

if ! [[ "$SERVED" =~ ^[0-9a-f]{40}$ ]]; then
  say "::error title=ENGINE PROVENANCE UNKNOWN::$ENGINE_URL/health did not return a usable commit version."
  summary '### Engine provenance: UNKNOWN'
  summary ''
  summary 'The live engine did not return a usable commit version; no release action was taken.'
  exit 1
fi

if ! git cat-file -e "${SERVED}^{commit}" 2>/dev/null; then
  say "::error title=ENGINE PROVENANCE UNKNOWN::The served version $SERVED is not resolvable in protected-main history."
  summary '### Engine provenance: UNKNOWN'
  summary ''
  summary "The live version \`$SERVED\` could not be resolved in protected-main history."
  exit 1
fi

# An engine may legitimately be ahead of the latest runtime-affecting commit
# when main later changed tests or simulation only. Containment is the contract.
MAIN_SHA=$(git rev-parse origin/main)
if git merge-base --is-ancestor "$SERVED" "$MAIN_SHA" && \
   git merge-base --is-ancestor "$REQ_SHA" "$SERVED"; then
  say 'OK — the Hetzner engine contains the newest protected-main engine change.'
  summary '### Engine provenance: OK'
  summary ''
  summary "Hetzner serves \`$SERVED\`, which contains required \`$REQ_SHORT\`."
  exit 0
fi

# A daily engine may intentionally queue daytime merges. Only the OLDEST
# unserved runtime commit determines the deadline, so a fresh merge cannot
# conceal a missed overnight update. Unknown/foreign ancestry still refuses.
if git merge-base --is-ancestor "$SERVED" "$MAIN_SHA"; then
  FIRST_UNSERVED_TIME=$(git log --reverse --format=%cI "$SERVED..$REQ_SHA" -- \
    'server/**' ':(exclude)server/**/*.test.ts' ':(exclude)server/sim/**' ':(exclude)server/qualification/**' | sed -n '1p')
  if QUEUE_DUE=$(printf '%s' "$HEALTH" | node scripts/ci/daily-engine-provenance.mjs "$FIRST_UNSERVED_TIME"); then
    say "::notice title=ENGINE RELEASE QUEUED::Protected engine changes are queued for the daily 04:00 America/Chicago release; proof is due by $QUEUE_DUE."
    summary '### Engine provenance: QUEUED (not deployed)'
    summary "Hetzner serves \`$SERVED\`; required \`$REQ_SHORT\` is queued until $QUEUE_DUE."
    exit 0
  fi
fi

say "::error title=ENGINE PROVENANCE MISMATCH::Hetzner serves $SERVED but protected main requires $REQ_SHORT and must contain the served commit."
say 'stage-engine-release.yml prepares routine changes at 03:30 Chicago for the 04:00 certified window; urgent/degraded emergencies retain their own admission. This audit never dispatches or retries.'
summary '### Engine provenance: BEHIND'
summary ''
summary "Hetzner serves \`$SERVED\`; protected main requires \`$REQ_SHORT\`."
exit 1
