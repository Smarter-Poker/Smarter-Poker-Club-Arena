# Horse Adaptive Retirement Groups Hands By Shared Batch

## What Was Wrong

After `20261015001555`, one owner call attempted 250 hands in qualified
order and then rewrote 291 distinct observation batches (46 MB of canonical
JSON, about 166 KB each) to remove about 2.5 tuples from each. Measured on
production 2026-10-15 01:24-01:29 UTC, a continuous drain retired about 17.5
hands per second against about 13.5 arriving, so the 988,441-hand backlog
would have taken about 70 hours and roughly 1 TB of WAL. Each call also ran
past the engine lane's 5-second transport timeout.

Measured on production: the 108 pending hands of one seed batch touch only 17
batches in total.

## The Fix

Migration `20261015022307_horse_adaptive_retirement_groups_hands_by_shared_batch.sql`
changes candidate selection only. The owner still walks seeds in the original
`(qualified_at, hand_id)` window order under the same fixed high-water. For
each seed not already attempted in the call it reads the seed's own batch
payloads (membership by `hand_digest`, the primary key prefix), collects the
hand ids they name, and attempts the seed first and then its pending window
batch-mates at or after the seed, in order, within the same 250-hand budget
and 2-second deadline. The cursor advances only to seeds. Batch-mates retired
early leave the window; a protected batch-mate stays pending and is attempted
again when the cursor reaches it.

`retire_horse_adaptive_hand_deferred` remains the only authority. Once-per-call
compaction, statistics expiry, the receipt, capacity lock, budgets, owner,
security definer, search path, lock timeout and ACLs are unchanged. It refuses
to apply unless the installed owner is exactly the `20261015001555`
postimage. No job, schedule, repair or backfill.

## Proof

`scripts/verification-harness/horse-adaptive-batch-once.py` installs the
grouped owner on top of the index correction in the corrected and rollback
worlds, so every byte-identity, protection, idempotency, release and atomicity
assertion runs against it, and it proves replay refusal and the installed
seed-and-batch-mate selection.
