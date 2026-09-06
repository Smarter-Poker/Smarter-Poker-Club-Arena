# tests/the-guards-are-wired.law.test.ts

`scripts/guard-merged-branch.sh` must stay wired into `.husky/pre-push`, must
run before the expensive suites, and must keep failing OPEN.

It is the one thing standing between an agent and a push that succeeds while
delivering nothing: autopilot squash-merges the moment the required checks pass,
and a commit pushed after that lands on a closed pull request. World Hub #1387
shipped 1 of its 3 commits that way on 2026-09-06.

Removing the call is a one-line diff that reads like tidying, and nothing else
in the repo would notice. Fail-open is pinned too, because a guard that blocks
every push when GitHub is unreachable gets deleted rather than debugged.
