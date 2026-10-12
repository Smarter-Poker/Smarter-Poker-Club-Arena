# Two finished leaderboard qualification workflows are retired

Date: 2026-10-12

## The ruling

Dan, verbatim, about the two permanently red qualification workflows that were
the only reason `Production Integrity Audit` had been red for 30 days:

> "REMOVE THEM OR FIX THEM, WHICH EVER IS EASIER"

Removing them is the easier path, and the correct one: neither can produce a
meaningful verdict any more, and the programme they qualified is finished.

## What was removed

| Workflow                                              | File                                                                 | Why it is retired                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leaderboard Current Schema Isolation Preflight        | `.github/workflows/leaderboard-isolation-preflight.yml`              | It exports metadata from a dedicated paid read replica that has been decommissioned. It cannot run at all; every dispatch in the scanned window failed, with no green run.                                                                                                                                                                                |
| Leaderboard Isolated Financial Baseline Qualification | `.github/workflows/leaderboard-isolated-financial-qualification.yml` | It expected the refusal string `LEADERBOARD_SNAPSHOT_UNAVAILABLE`, which was never adopted; production raises `LEADERBOARD_CAPTURE_UNAVAILABLE`. The defects it exposed were fixed at the root by migration `20261009111728` (#6572), and payout is covered by `leaderboard-isolated-financial-repair-qualification.yml`, which passed (run 37926144073). |

Harness files used only by the baseline qualification were removed with it:

- `scripts/verification-harness/leaderboard-financial-integration-candidate.mjs` and its test
- `scripts/verification-harness/leaderboard-financial-diagnostics.mjs` and its test
- `scripts/verification-harness/leaderboard-isolated-funding-policy-draft.sql`

## What was kept

Everything another workflow still uses: `leaderboard-isolation-preflight.sh`
and its test, `leaderboard-schema-replica.mjs`, the native metadata batch
build, the concurrency and unknown-ack drafts, the authorization, payout and
concurrency fixture drafts, and both remaining qualification workflows
(`Leaderboard Isolated Actual Auth Qualification` and
`Leaderboard Isolated Financial Repair Qualification`).

`leaderboard-native-function-batch.test.mjs` pinned all four qualification
doors; it now pins the two that remain, with the same assertions.

## The detector was not changed

`scripts/ci/check-main-is-green.mjs` reads only workflows GitHub reports as
`active` (`collectActiveWorkflowRuns` in `scripts/ci/lib/workflowVerdicts.mjs`),
and it still has no name-based exception list. Both workflows were also
disabled through the GitHub API, so the detector stops reading their old runs
whether or not GitHub has yet marked the deleted files as deleted. Nothing
else the detector reads was weakened.
