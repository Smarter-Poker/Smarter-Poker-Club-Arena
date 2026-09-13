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
  *github.com:Smarter-Poker/*|*github.com/Smarter-Poker/*) ;;
  *)
    echo "[merged-branch guard] BLOCKED: remote '$REMOTE_NAME' is not an identified Smarter-Poker GitHub destination." >&2
    exit 1
    ;;
esac
REPO="${REMOTE_URL##*Smarter-Poker/}"
REPO="${REPO%.git}"
REPO="${REPO%/}"
if [[ ! "$REPO" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "[merged-branch guard] BLOCKED: remote '$REMOTE_NAME' has an unreadable repository name." >&2
  exit 1
fi
SLUG="Smarter-Poker/$REPO"

if ! command -v gh >/dev/null 2>&1; then
  echo "[merged-branch guard] BLOCKED: GitHub CLI is required to verify destination branch '$BRANCH'." >&2
  exit 1
fi

# `gh` uses its credential store or a standard process-level GH_TOKEN. This
# guard never opens a repository `.env`, never scrapes another product's
# credentials, and never copies a token into a command line.
RESP="$(GH_PAGER=cat gh api -X GET "repos/$SLUG/pulls" \
  -f "head=Smarter-Poker:$BRANCH" -f state=all -F per_page=10 \
  2>/dev/null || true)"

if [[ -z "$RESP" ]]; then
  echo "[merged-branch guard] BLOCKED: GitHub CLI did not provide an authenticated verdict for '$BRANCH'." >&2
  exit 1
fi

VERDICT="$(printf '%s' "$RESP" | python3 -c '
import json, sys
try:
    prs = json.load(sys.stdin)
except Exception:
    print("ERROR")
    raise SystemExit
if not isinstance(prs, list):
    print("ERROR")
elif not prs:
    print("NONE")
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
' 2>/dev/null || echo ERROR)"

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
