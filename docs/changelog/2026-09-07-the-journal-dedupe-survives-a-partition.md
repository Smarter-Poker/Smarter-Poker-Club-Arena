# 2026-09-07 - The journal's dedupe survives a partition

Phase 5, stage 1 of `docs/THE-JOURNAL-PARTITION-CUT.md`. Additive and
reversible: nothing depends on it yet and the index it shadows is still there.

## Why it had to come first

Dan ruled that `chip_ledger` keeps every leg for ever, partitioned by month.
Postgres requires every UNIQUE index on a partitioned table to include the
partition key, so `ux_chip_ledger_idempotency_key` would become
`(idempotency_key, created_at)`. That is not a weaker form of the same
guarantee - it is a different one. **The same key in two different months would
both be accepted**, which is precisely the double-record defect fixed on
`tournament_payouts` the day before, re-introduced into the journal itself.

So the guarantee moves out of the journal into `chip_ledger_idem`, keyed by the
idempotency key, never partitioned, never dropped with a partition. The unique
violation happens there.

## What it costs, measured

Of **2,004,587** legs, exactly **1,611** carry an idempotency key. The companion
is a 1,611-row table and the trigger returns immediately on the other 99.92% of
inserts without touching anything. That is the whole cost.

## And why the hash chain does not need the same treatment

`chip_ledger_chain_seq_key` is the other unique index, over 1,786,348 legs, and
building a second 68 MB companion for it would be waste. `chain_seq` comes from
a sequence and `created_at` is fixed at insert, so a given chain_seq is issued
once and lands in exactly one partition: `(chain_seq, created_at)` is
effectively as strong as `chain_seq` alone. The residual risk is a hand-written
row with a duplicate chain_seq and a different timestamp, and the journal is
append-only with its own guard against that.

The chain is also complete rather than patchy, which is worth recording because
2,004,587 - 1,786,348 = 218,239 legs carry no `chain_seq` at all and that looks
alarming until you plot it: the chain was switched on partway through
2026-08-31, and every leg from 09-01 onward carries both `chain_seq` and
`row_hash`, 100% of every day. The unchained legs are simply older than the
chain.

## Proved, not assumed

The migration asserts the backfill is exact in **both** directions with
`EXCEPT`, never by count alone: 1,612 keyed legs, 1,612 claims, 0 missing, 0
extra. (1,612 rather than the 1,611 measured minutes earlier - a keyed leg
arrived in between, which is the platform working.)

The live path was then proved separately and rolled back, per CLAUDE.md 11.5: a
real keyed leg inserted into `chip_ledger` had its key claimed by the trigger
with the claim naming that leg, and a second leg carrying the same key was
refused with a unique violation. Nothing survived the rollback - 0 probe legs, 0
probe claims - and the counts are unchanged at 1,612/1,612 with 0 unclaimed.

Both mechanisms now run together. That is deliberate: if they ever disagree, it
is a bug found while both are still there to compare, which is what stage 2 of
the plan is for.
