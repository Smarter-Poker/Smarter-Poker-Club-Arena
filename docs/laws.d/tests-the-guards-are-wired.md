# tests/the-guards-are-wired.law.test.ts

`scripts/guard-merged-branch.sh` must stay executable, wired into
`.husky/pre-push`, run before the expensive suites, and fail closed when GitHub
cannot provide an authenticated branch verdict.

It is the one thing standing between an agent and a push that succeeds while
delivering nothing: autopilot squash-merges the moment the required checks pass,
and a commit pushed after that lands on a closed pull request. World Hub #1387
shipped 1 of its 3 commits that way on 2026-09-06.

Removing the call is a one-line diff that reads like tidying, and nothing else
in the repo would notice. The guard uses the GitHub CLI credential store,
refuses local env/token discovery and bypass flags, and the push test gate must
diff the commits being pushed rather than an empty working tree.
