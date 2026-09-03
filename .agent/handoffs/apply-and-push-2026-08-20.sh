#!/usr/bin/env bash
#
# Ship the 2026-08-20 session: BBJ popup, whole-number buy-ins, no raw server
# errors in popups.
#
#   cd ~/Documents/Smarter-Poker-Club-Arena
#   bash .agent/handoffs/apply-and-push-2026-08-20.sh
#
# It refuses to push unless tsc, the UI-text gate and the production build all
# pass. Nothing here touches your current branch until it has fetched, and it
# works on a throwaway branch that it pushes straight to main.
#
# Why this exists: the Cowork session had no SSH key and no credential helper,
# and the GitHub MCP token has no private-repo scope on this repo, so it could
# not push. Full detail in 2026-08-20-bbj-popup-buyins-errors.md.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PATCH="$REPO/.agent/handoffs/2026-08-20-bbj-popup-buyins-errors.patch"
BRANCH="ship-bbj-popup-2026-08-20"
BASE="a107f7eff95a1f6740588add63ecbfd8a8a6704f"
AUTHOR_NAME="Smarter-Poker"
AUTHOR_EMAIL="254329056+Smarter-Poker@users.noreply.github.com"
MSG="feat(ca): BBJ popup rebuilt - Winner / Basic / Qualifying Hands with a full hand rundown, whole-number tournament buy-ins, and no raw server errors in popups"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mSTOP: %s\033[0m\n' "$*" >&2; exit 1; }

cd "$REPO"
[ -f "$PATCH" ] || die "patch not found at $PATCH"

say "Checking the working tree"
if [ -n "$(git status --porcelain)" ]; then
  cat <<'EOF'
Your working tree has uncommitted changes.

Some of it is other agents' in-flight work (a CashierTradePage, lobby quick
preference rows, a double-board engine flag) that is NOT part of this patch and
should not be lost. Stash or commit it first, then re-run:

    git stash push -u -m "pre-bbj-popup"

EOF
  die "working tree not clean"
fi

say "Fetching origin"
git fetch origin

say "Creating $BRANCH from origin/main"
git checkout -B "$BRANCH" origin/main

if [ "$(git rev-parse HEAD)" != "$BASE" ]; then
  echo "Note: origin/main has moved since the patch was built."
  echo "  patch base : $BASE"
  echo "  origin/main: $(git rev-parse HEAD)"
  echo "The three-way apply below will reconcile it, or stop and tell you what conflicts."
fi

say "Applying the patch (three-way)"
git apply -3 --whitespace=nowarn "$PATCH" || die "patch did not apply cleanly - resolve the conflicts, then re-run from the gates below"

if git diff --name-only --diff-filter=U | grep -q .; then
  echo "Conflicted files:"
  git diff --name-only --diff-filter=U
  die "resolve the conflicts above, then run the gates and commit by hand"
fi

say "Gate 1/3 - TypeScript"
npx tsc --noEmit || die "tsc failed"

say "Gate 2/3 - UI text (no em dashes)"
node scripts/ci/check-ui-text.mjs || die "UI text gate failed"

say "Gate 3/3 - production build"
NODE_ENV=production npx vite build || die "vite build failed"

say "Committing as $AUTHOR_NAME"
git add -A
git -c user.name="$AUTHOR_NAME" -c user.email="$AUTHOR_EMAIL" commit -m "$MSG"

say "Pushing to main"
git push origin "$BRANCH:main"

say "Pushed. The build-for-world-hub GitHub Action will sync the build to the World Hub and Vercel will deploy it."
echo
echo "Do not call this deployed until production actually serves it. Verify with:"
echo "  bash ~/Documents/Smarter-Poker-World-Hub/scripts/git-safe-push.sh \"chore: verify club-arena sync\""
echo "or watch the Action at https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions"
