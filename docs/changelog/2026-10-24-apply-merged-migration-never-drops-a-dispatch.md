# 2026-10-24 - Apply Merged Migration never drops a dispatched file

## What happened

#7920 merged three migrations. Each was dispatched to Apply Merged Migration
in the same second (22:53:57Z). The workflow had one concurrency group,
`apply-merged-migration`, and GitHub keeps at most ONE pending run per group,
cancelling the older pending run when a newer one arrives, even with
`cancel-in-progress: false`. Result: run 40140491309 applied
20261024194135; runs 40140491358 and 40140492088 ended `cancelled`.
`cancelled` is not red, so nothing alerted, and
20261024193700_a_rebuy_is_never_seated_on_a_table_being_broken and
20261024204950_a_pre_money_mystery_rebuy_retires_its_old_head_snapshot stayed
merged and uninstalled (the Production Integrity Audit reports both).

## Root fix

The concurrency group is keyed by the migration file from both doors, so two
different files can never cancel each other; the same file dispatched twice
still serialises. The cost is that two different files may each take a
PostgREST schema reload at the same time; every file is still its own single
transaction with its own lock_timeout and schema_migrations guard.

Pinned by `tests/unit/applyMergedMigrationNeverDropsADispatch.test.ts` and the
updated assertion in `scripts/ci/contract-index-recovery.test.mjs`.

## Still to do

The two dropped files must be dispatched once each through this workflow.
They are self-guarding (md5 of the body they patch, refuse otherwise).
