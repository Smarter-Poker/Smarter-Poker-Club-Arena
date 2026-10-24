# The Migration Applier Never Drops A Dispatch

Found in the 2026-10-24 production sweep: three migrations merged at 21:58 UTC were never applied to production, and one of them is why late registrations and rebuys were being refused:

- `20261024193700_a_rebuy_is_never_seated_on_a_table_being_broken`
- `20261024194135_an_authored_equal_blind_level_can_open_a_table` (its commit counts 180 refused late registrations and 9 refused rebuys in 24 h)
- `20261024204950_a_pre_money_mystery_rebuy_retires_its_old_head_snapshot`

## Cause

`apply-merged-migration.yml` put every run in one concurrency group, `apply-merged-migration`. GitHub keeps at most one pending run per group and cancels the older pending run when a newer one is queued. Several dispatches in a row therefore applied one file and silently cancelled the rest; two of the three 22:53 dispatches show `cancelled`. Nothing reported it.

## Fix

- The concurrency group is per file: `apply-merged-migration-<file>`, never cancelled in progress. A second dispatch of the same file still waits behind the first.
- `scripts/ci/apply-recorded-migration.mjs` takes a session advisory lock (`hashtextextended('apply-recorded-migration', 0)`) right after connecting and before it reads the migration history. Different files are applied one at a time, as the single group intended, but none is dropped, and a run that waited sees what the run ahead of it installed. The wait is bounded at 12 minutes, inside the job's 15. A timeout has sent nothing and ends as a refusal ("dispatch this file again"). A dry run sends nothing and does not wait.

Proved locally: while one session holds the lock, a second with a short `lock_timeout` fails with `55P03`, and acquires it once the first releases. Pinned by `tests/unit/applyMergedMigrationNeverDropsADispatch.test.ts`; the existing pin in `scripts/ci/contract-index-recovery.test.mjs` moved to the per-file group in the same commit.
