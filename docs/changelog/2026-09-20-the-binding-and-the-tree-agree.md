# The Binding And The Tree Agree

Date: 2026-09-20. Repository records only. One file changed. No migration, no
client behaviour, no engine change, no workflow change.

## What was wrong

`tests/fixtures/full-weekly-accounting/source-binding.json` pins the sha256 of
423 repository paths under `repository_fixtures`, and
`scripts/dev/test-full-weekly-accounting-activation.sh` verifies every one of
them before it installs a single component, raising
`Repository lifecycle fixture drift: <path>` on the first mismatch. That is
deliberate: the weekly accounting qualification claims coverage FROM those
files, so a change to one has to be re-qualified and re-recorded rather than
absorbed in silence.

PR #4943 retired the browser dispute-escalation entry point on 2026-09-19. It
was right to. The `authenticated` role has no UPDATE grant on
`public.disputes` and the table's only policy is SELECT, so the method
answered 42501 on every call while still incrementing its own counter and
persisting a "dispute auto-escalated" alert through a function `authenticated`
can execute. Two bound application tests moved with it:
`tests/unit/FinancialCronService.test.ts` now asserts the method is absent and
that booting the service never touches the disputes table, and
`tests/unit/discardedErrorReadRatchet.test.ts` drops its
`src/services/FinancialCronService.ts` baseline entry because the discarded
read is gone. Both changes widen coverage.

Its own required checks were green, because its paths do not route to the
accounting job. It merged at 22:31 UTC, and from the next main run onward the
required "Accounting transactions (PostgreSQL 17)" check failed on main and on
every open pull request with
`Repository lifecycle fixture drift: tests/unit/FinancialCronService.test.ts`.
Runs 35478014685 and 35490389682 on main, plus every pull request run in
between, each burned a full PostgreSQL job to report a drift its author had not
caused and could not see in their own diff. PR #4946 was blocked by it.

The drift is still present on `main` as this is written. Main reads green only
because the newest commits do not route to the accounting job either, so the
check that would refuse them has not run. A check that does not run is not a
check that passed.

## What changed

The two hashes are re-recorded, and the reason is written down in the shape the
binding already uses for a rebinding: `retired_dispute_escalation_rebinding_20260920`
names the base commit, the previous binding's own sha256, the failed runs, the
source pull request and commit, each path with its `previous_sha256` and its new
`sha256`, why the change is acceptable and how it was verified. That is the same
shape as `mtt_integration_ci_binding_20260918`.

Nothing else in the binding moved. The captured `fixtures` map, `component_count`,
both assertion counts, `limits` and `supplemental_captures` are byte-identical to
the previous binding, and that was asserted rather than eyeballed.

## How it was verified

Each new sha256 was recomputed from the bytes on disk at this base commit. All
423 repository bindings were then re-verified against the tree and every one
agrees. The edit was made through a JSON round-trip proved byte-identical to the
original file first, so the diff is exactly the two hashes and the added note:
24 insertions, 2 deletions, one file.

## What this does not do

It does not stop the next one. The binding already records this same shape twice
before today, `mtt_integration_ci_binding_20260918` (failed run 35380573338) and
`diamond_replay_ci_binding_20260919` (failed run 35453124666), which makes three.
Three times is a missing check rather than three accidents, and the hole is that
the verification runs only inside the heavy PostgreSQL accounting job that
`scripts/ci/classify-ci-changes.mjs` starts from the changed paths. A pull
request that edits a bound path which is not itself an accounting path never runs
it. Closing that is a separate change and is deliberately not bundled here: this
one has to land quickly and touch as little as possible, because until it does,
every pull request that routes to the accounting job is refused for something its
author did not do.
