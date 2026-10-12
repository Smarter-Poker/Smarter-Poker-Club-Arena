# A git-fixture test gets a real budget (2026-10-03)

Phase 5 of 9 (main CI green).

`tests/stamp-build-provenance.test.ts` builds a real git fixture for every test and runs the stamper as a child process: `git init`, commits, a fetched origin and a captured PR merge. That takes about 300 ms on an idle machine. On a loaded CI shard it crossed vitest's 5,000 ms default (job 111181226645, on PR #5946, a change to SQL and fixtures only) and failed a pull request that touched none of this code.

The file now sets `vi.setConfig({ testTimeout: 90_000 })`, the same budget the other git-fixture tests use (`a-race-that-touched-nothing-names-it-and-waits`, `every-pinned-source-stays-bound`, `an-owed-engine-release-is-offered-until-production-holds-it`). No assertion waits on a clock. The budget only covers the real git work, so a slow runner can no longer turn correct code red.
