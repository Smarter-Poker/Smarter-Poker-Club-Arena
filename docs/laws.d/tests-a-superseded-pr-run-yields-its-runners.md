# tests/a-superseded-pr-run-yields-its-runners.law.test.ts

Hosted runners are capped, and on 2026-10-24 about 146 runs sat queued while the
Club Arena publisher waited 1.5 hours and Apply Merged Migration dispatches
waited 20+ minutes. Over six hours 118 heavy ci.yml jobs started after their
pull request head had already been replaced and spent 1,099 runner-minutes on
commits nobody would merge, because ci.yml keeps its head-sha group and never
cancels in progress (a cancelled head once stranded six PRs). The law pins four
things: every pull_request and pull_request_target workflow cancels a superseded
run of the same PR (keyed on the PR number for pull_request_target), except
ci.yml and money-trigger-recovery.yml, whose reasons are written in the test;
nothing that publishes, deploys, stages, applies a migration or records
production evidence can cancel mid-run; each heavy ci.yml job runs
scripts/ci/yield-superseded-pr-ci.mjs right after Checkout and no fast gate or
aggregator does; and that script cancels only its own run, only when the PR is
open and same-repository, its head is a different sha, and that head already
has a newer ci.yml run of its own, re-reading the head before the write and
failing open on anything it cannot read.
