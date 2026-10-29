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

# Parse only GitHub HTTPS/SSH destinations; the new owner is trusted only for
# the explicitly approved Club Arena repository and immutable identity below.
if [[ "$REMOTE_URL" =~ ^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)(Smarter-Poker|Smarter-Software-PIQ)/([A-Za-z0-9._-]+)/*$ ]]; then
  OWNER="${BASH_REMATCH[2]}"
  REPO="${BASH_REMATCH[3]}"
  REPO="${REPO%.git}"
else
  echo "[merged-branch guard] BLOCKED: remote '$REMOTE_NAME' is not an identified GitHub destination." >&2
  exit 1
fi
if [[ "$OWNER" != Smarter-Poker && "$REPO" != Smarter-Poker-Club-Arena ]]; then
  echo "[merged-branch guard] BLOCKED: unapproved transferred repository." >&2
  exit 1
fi
SLUG="$OWNER/$REPO"

if ! command -v gh >/dev/null 2>&1; then
  echo "[merged-branch guard] BLOCKED: GitHub CLI is required to verify destination branch '$BRANCH'." >&2
  exit 1
fi

# Resolve the approved Club Arena alias through authenticated repository metadata.
# Both requested and returned names must belong to the same immutable repository.
if [[ "$REPO" == Smarter-Poker-Club-Arena ]]; then
  METADATA="$(GH_PAGER=cat gh api -X GET "repos/$SLUG" 2>/dev/null || true)"
  CANONICAL="$(printf '%s' "$METADATA" | node --input-type=module -e '
import { isClubArenaRepository } from "./scripts/ci/repository-identity.mjs";
let input = "";
for await (const part of process.stdin) input += part;
try {
  const metadata = JSON.parse(input);
  if (!isClubArenaRepository(process.argv[1], metadata.id) ||
      !isClubArenaRepository(metadata.full_name, metadata.id)) process.exit(1);
  console.log(metadata.full_name);
} catch { process.exit(1); }
' "$SLUG" 2>/dev/null)" || CANONICAL=""
  if [[ -z "$CANONICAL" ]]; then
    echo "[merged-branch guard] BLOCKED: unreadable or mismatched immutable repository identity." >&2
    exit 1
  fi
  SLUG="$CANONICAL"
  OWNER="${SLUG%%/*}"
fi

# `gh` uses its credential store or a standard process-level GH_TOKEN. This
# guard never opens a repository `.env`, never scrapes another product's
# credentials, and never copies a token into a command line.
RESP="$(GH_PAGER=cat gh api -X GET "repos/$SLUG/pulls" \
  -f "head=$OWNER:$BRANCH" -f state=all -F per_page=10 \
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
