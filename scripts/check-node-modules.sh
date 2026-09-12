#!/usr/bin/env bash
# THE SHARED node_modules IS ONE INSTALL BEHIND FORTY-SEVEN WORKTREES.
#
# scripts/agent-workspace.sh symlinks node_modules from the main clone into every
# worktree, so hooks and the test gate work without a per-tree install. That link
# is NOT read-only: `npm install` or `npm ci` run inside a worktree resolves
# through it and rewrites the SHARED tree.
#
# It happened twice on 2026-08-23. Each time npm left ~285 package directories
# EMPTY - present, so `[ -d node_modules/typescript ]` still passed, but with no
# package.json inside. Every pre-push hook in every worktree then died on
# check-title-case.mjs with ERR_MODULE_NOT_FOUND, which names a path and explains
# nothing. Nobody would guess "another agent ran npm install in a different
# directory" from that.
#
# This probe resolves what the hooks actually need. On the Mac it is always
# read-only: dependency installation belongs in CI, including repairs to a
# shared install. Non-Mac callers retain the explicit legacy repair behavior.
#
#     bash scripts/check-node-modules.sh           # Mac: probe only
#     bash scripts/check-node-modules.sh --check   # probe only, exit 1 if broken
set -euo pipefail

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1
MAC_HOST=0
if [ "$(uname -s)" = Darwin ]; then
  MAC_HOST=1
  CHECK_ONLY=1
fi

ROOT=$(git rev-parse --path-format=absolute --git-common-dir); ROOT=${ROOT%/.git}
NM="$ROOT/node_modules"
[ -d "$NM" ] || {
  if [ "$MAC_HOST" = 1 ]; then
    echo "  no shared node_modules in $ROOT; install and verify dependencies in CI"
  else
    echo "  no node_modules in $ROOT - run: (cd $ROOT && npm ci)"
  fi
  exit 1
}

# The packages the hooks import. A package whose directory exists but whose
# package.json does not is the exact shape npm leaves behind.
BROKEN=""
for p in typescript vitest prettier; do
  [ -f "$NM/$p/package.json" ] || BROKEN="$BROKEN $p"
done
EMPTY=$(find "$NM" -maxdepth 1 -type d -empty 2>/dev/null | wc -l | tr -d ' ')

if [ -z "$BROKEN" ] && [ "$EMPTY" -lt 5 ]; then
  exit 0
fi

echo ""
echo "  ─────────────────────────────────────────────────────────────────────"
echo "  THE SHARED node_modules IS GUTTED."
echo ""
echo "    $ROOT/node_modules"
echo "    missing package.json for:${BROKEN:- none}"
echo "    empty package directories: $EMPTY"
echo ""
echo "  Every worktree symlinks this directory, so every worktree's hooks are"
echo "  broken right now, not just yours. The cause is always the same: an"
echo "  \`npm install\` or \`npm ci\` run INSIDE a worktree, which writes through"
if [ "$MAC_HOST" = 1 ]; then
  echo "  the symlink. No Mac install or repair will run; use CI for dependency checks."
else
  echo "  the symlink. Add dependencies in $ROOT and run npm ci THERE."
fi
echo "  ─────────────────────────────────────────────────────────────────────"
echo ""

if [ "$CHECK_ONLY" = "1" ]; then exit 1; fi

echo "  repairing with npm ci in the main clone (about a minute)..."
( cd "$ROOT" && npm ci --silent ) || { echo "  npm ci FAILED - run it by hand in $ROOT"; exit 1; }
for p in typescript vitest prettier; do
  [ -f "$NM/$p/package.json" ] || { echo "  still broken: $p"; exit 1; }
done
echo "  repaired. Every worktree is working again."
