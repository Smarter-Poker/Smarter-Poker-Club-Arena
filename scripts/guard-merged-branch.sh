#!/usr/bin/env bash

# Refuse a push to a branch whose pull request has already closed or merged.
# The pre-push hook passes the actual destination branch from Git's stdin, so
# this guard never guesses from HEAD and has no bypass. An unreadable authority
# fails closed: a successful but orphaned push is the defect being prevented.

set -uo pipefail

BRANCH="${1:-}"
REMOTE_NAME="${2:-}"
REMOTE_URL="${3:-}"
case "$BRANCH" in
  ''|HEAD|main|master) exit 0 ;;
esac
if ! git check-ref-format "refs/heads/$BRANCH" >/dev/null 2>&1; then
  echo "[merged-branch guard] BLOCKED: '$BRANCH' is not a valid destination branch." >&2
  exit 1
fi

case "$REMOTE_URL" in
  git@github.com:Smarter-Poker/*|https://github.com/Smarter-Poker/*|ssh://git@github.com/Smarter-Poker/*)
    REPO="${REMOTE_URL##*Smarter-Poker/}"
    OWNER="Smarter-Poker"
    ;;
  git@github.com:Smarter-Software-PIQ/*|https://github.com/Smarter-Software-PIQ/*|ssh://git@github.com/Smarter-Software-PIQ/*)
    REPO="${REMOTE_URL##*Smarter-Software-PIQ/}"
    OWNER="Smarter-Software-PIQ"
    ;;
  *)
    echo "[merged-branch guard] BLOCKED: remote '$REMOTE_NAME' is not an identified Smarter-Poker GitHub destination." >&2
    exit 1
    ;;
esac
REPO="${REPO%/}"
REPO="${REPO%.git}"
if [[ ! "$REPO" =~ ^[A-Za-z0-9._-]+$ ]] || [[ "$OWNER" == "Smarter-Software-PIQ" && "$REPO" != "Smarter-Poker-Club-Arena" ]]; then
  echo "[merged-branch guard] BLOCKED: remote '$REMOTE_NAME' has an unreadable or unapproved repository name." >&2
  exit 1
fi
SLUG="$OWNER/$REPO"
HEAD_REPO_ID=""

if ! command -v gh >/dev/null 2>&1; then
  echo "[merged-branch guard] BLOCKED: GitHub CLI is required to verify destination branch '$BRANCH'." >&2
  exit 1
fi

# Resolve transfers before filtering heads: GitHub redirects the old repository
# API, but does not rewrite an old-owner head filter. Trust the maintained
# approved names plus immutable ID, never an arbitrary redirected owner.
IDENTITY="$(GH_PAGER=cat gh api -X GET "repos/$SLUG" 2>/dev/null || true)"
TRUST_HELPER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ci/repository-identity.mjs"
RESOLVED="$(printf '%s' "$IDENTITY" | node --input-type=module -e '
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
const {isClubArenaRepository}=await import(pathToFileURL(process.argv[1]));
try {
  const r=JSON.parse(readFileSync(0,"utf8"));
  const requested=process.argv[2];
  if (requested.endsWith("/Smarter-Poker-Club-Arena")) {
    if (!isClubArenaRepository(requested,r.id) || !isClubArenaRepository(r.full_name,r.id)) throw Error();
  } else if (!requested.startsWith("Smarter-Poker/") || r.full_name!==requested) throw Error();
  if (r.owner?.login !== r.full_name.split("/")[0]) throw Error();
  console.log(r.full_name + "\t" + (requested.endsWith("/Smarter-Poker-Club-Arena") ? r.id : ""));
} catch { process.exitCode=1; }
' "$TRUST_HELPER" "$SLUG" 2>/dev/null)"
if [[ -z "$RESOLVED" ]]; then
  echo "[merged-branch guard] BLOCKED: GitHub did not identify the trusted destination repository." >&2
  exit 1
fi
IFS=$'\t' read -r SLUG HEAD_REPO_ID <<< "$RESOLVED"
HEAD_OWNER="${SLUG%%/*}"

# `gh` uses its credential store or a standard process-level GH_TOKEN. This
# guard never opens a repository `.env`, never scrapes another product's
# credentials, and never copies a token into a command line.
RESP="$(GH_PAGER=cat gh api -X GET "repos/$SLUG/pulls" \
  -f "head=$HEAD_OWNER:$BRANCH" -f state=all -F per_page=10 \
  2>/dev/null || true)"

if [[ -z "$RESP" ]]; then
  echo "[merged-branch guard] BLOCKED: GitHub CLI did not provide an authenticated verdict for '$BRANCH'." >&2
  exit 1
fi

VERDICT="$(printf '%s' "$RESP" | python3 -c '
import json, sys
owner, branch, repo_id = sys.argv[1:]
try:
    prs = json.load(sys.stdin)
except Exception:
    print("ERROR")
    raise SystemExit
if not isinstance(prs, list):
    print("ERROR")
elif not prs:
    print("NONE")
elif any(not isinstance(p, dict) or p.get("state") not in ("open", "closed")
         or not isinstance(p.get("number"), int)
         or p.get("head", {}).get("ref") != branch
         or p.get("head", {}).get("repo", {}).get("owner", {}).get("login") != owner
         or (repo_id and str(p.get("head", {}).get("repo", {}).get("id")) != repo_id)
         for p in prs):
    print("ERROR")
else:
    prs.sort(key=lambda p: p.get("number", 0), reverse=True)
    pr = prs[0]
    number = pr.get("number", "unknown")
    if pr.get("merged_at"):
        print(f"MERGED {number}")
    elif pr.get("state") == "closed":
        print(f"CLOSED {number}")
    else:
        print(f"OPEN {number}")
' "$HEAD_OWNER" "$BRANCH" "$HEAD_REPO_ID" 2>/dev/null || echo ERROR)"

case "$VERDICT" in
  NONE|OPEN\ *) exit 0 ;;
  MERGED\ *|CLOSED\ *)
    state="${VERDICT%% *}"
    pr="${VERDICT#* }"
    echo "[merged-branch guard] BLOCKED: destination '$BRANCH' belongs to $state pull request #$pr." >&2
    echo "[merged-branch guard] Create a new branch from current origin/main and carry the follow-up commit there." >&2
    exit 1
    ;;
  *)
    echo "[merged-branch guard] BLOCKED: GitHub returned an unreadable branch verdict for '$BRANCH'." >&2
    exit 1
    ;;
esac
