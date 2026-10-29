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

# A transfer preserves the immutable repository ID, but changes both canonical
# API name and PR head owner. Resolve CA through the existing identity authority;
# never let an obsolete owner filter turn a closed PR into an empty-list verdict.
if [[ "$REPO" == "Smarter-Poker-Club-Arena" ]]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "[merged-branch guard] BLOCKED: Node.js is required to verify repository identity." >&2
    exit 1
  fi
  METADATA="$(GH_PAGER=cat gh api -X GET "repos/$SLUG" 2>/dev/null || true)"
  IDENTITY_MODULE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ci/repository-identity.mjs"
  CANONICAL="$(printf '%s' "$METADATA" | node --input-type=module -e '
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { assertClubArenaRepository, CLUB_ARENA_REPOSITORY_ID } = await import(pathToFileURL(process.argv[1]).href);
const metadata = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(assertClubArenaRepository(metadata.full_name, metadata.id) + "\t" + CLUB_ARENA_REPOSITORY_ID);
' "$IDENTITY_MODULE" 2>/dev/null || true)"
  if [[ -z "$CANONICAL" ]]; then
    echo "[merged-branch guard] BLOCKED: GitHub did not verify the exact Club Arena repository identity." >&2
    exit 1
  fi
  IFS=$'\t' read -r SLUG HEAD_REPO_ID <<< "$CANONICAL"
fi
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
