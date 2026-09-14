# tests/the-docs-describe-this-environment.law.test.ts

A binding doc may not assert something about this machine that stopped being
true, with nothing checking. Three mechanically checkable claims are pinned: a
script a doc NAMES must exist (CLAUDE.md carried `.github/scripts/engine-watchdog.sh`
for days after #4189 deleted it); an override a doc or a guard's own header
DOCUMENTS must be read by something in the tree (10.82 promised
`AGENT_MERGED_BRANCH_OK=1` after `guard-merged-branch.sh` was rewritten without
it, and an agent blocked by the guard spends its time on a variable nothing
reads); and a tool a doc calls ABSENT must not be one this repo's own guards
require - `gh` was called "not installed" in two binding docs while
`guard-merged-branch.sh` failed closed without it, when the truth was that
`/opt/homebrew/bin` is not on a non-interactive PATH. The fourth case pins the
fix: `.husky/pre-push` must put every tool its guards require on PATH.
