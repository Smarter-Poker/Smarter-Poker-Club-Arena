#!/usr/bin/env bash
# Fail LOUDLY when the autopilot token is dead.
#
# WHY: on this workflow's first run GH_PAT was expired. `gh` returned
# "HTTP 401: Bad credentials" from inside a loop and the job just went red with
# no indication that a CREDENTIAL, not the code, was the problem. A dead token
# means nothing merges and nothing publishes, silently — the exact failure mode
# this whole workflow exists to abolish. So we check it first, say so in plain
# words, and raise an issue that names the fix.
set -uo pipefail

if OUT=$(gh api user --jq .login 2>&1); then
  echo "token OK — authenticated as: $OUT"
  exit 0
fi

echo "::error::Agent Autopilot's token is invalid ($OUT)."
echo "::error::Nothing will auto-merge or publish until it is replaced."
echo "::error::Fix: gh secret set GH_PAT --repo ${GITHUB_REPOSITORY:-<repo>} --body <a fresh PAT with repo + pull_requests write>"

# Raise it where a human will actually see it, using the built-in token, which
# is always valid even when GH_PAT is not.
if [ -n "${GITHUB_TOKEN_FALLBACK:-}" ]; then
  export GH_TOKEN="$GITHUB_TOKEN_FALLBACK"
  TITLE="Agent Autopilot is down: GH_PAT is invalid"
  EXISTING=$(gh issue list --repo "$GITHUB_REPOSITORY" --state open --search "$TITLE in:title" --limit 1 --json number --jq '.[0].number' 2>/dev/null || echo "")
  if [ -z "$EXISTING" ]; then
    gh issue create --repo "$GITHUB_REPOSITORY" --title "$TITLE" \
      --body "\`gh api user\` returned:

\`\`\`
$OUT
\`\`\`

**Impact:** no PR will auto-merge and no merge will publish to the World Hub until this is replaced. Agents will appear to work and nothing will ship.

**Fix:** \`gh secret set GH_PAT --repo $GITHUB_REPOSITORY --body <fresh PAT>\` (needs repo contents + pull-requests write)." >/dev/null 2>&1 || true
  fi
fi
exit 1
