# Adaptive Batch-Once Compaction Uses The Hand Id Index

## What Broke

`20261014231333` installed on production at about 00:08 UTC on 2026-10-15.
From then on every call of `public.fn_prune_horse_adaptive_journal()` ran past
its caller's statement timeout and rolled back. Adaptive retention retired zero
hands; the pending backlog went from 939,366 to 942,035 in three minutes.

## Cause, Read From The Plan

The once-per-call batch lookup (owner body line 58) matched
`c.hand_id::text=ANY(retired_hands)`. Casting the uuid column to text makes
`horse_adaptive_disposal_certificates_pkey` unusable, so the planner chose a
Parallel Seq Scan over about 3.9 million certificates joined to about 14
million membership rows, on every call. The CI fixture holds 40 hands, so it
could not show the cost.

Measured on production with the same 250 real pending hands: the uuid
comparison uses the certificates primary key and the membership primary key,
31.9 ms in total.

## Fix

`20261015001508_adaptive_batch_once_compaction_uses_the_hand_id_index.sql`
changes that one predicate to `c.hand_id=ANY(retired_hands::uuid[])`. The hands
in `retired_hands` and every tuple filter are unchanged, so the batches touched
and the postimage are identical. Budgets, capacity lock, cursor, receipt,
owner, definer, search path, lock timeout and ACLs are unchanged. It refuses to
apply unless the installed owner and deferred retire hashes are exactly the
production postimage of `20261014231333`. No job, schedule or backfill.

## Pinned

`scripts/verification-harness/horse-adaptive-batch-once.py` now installs the
fix in every world, refuses its replay, asserts the installed body compares
uuids (never `hand_id::text=ANY`), and asserts that with sequential scans
disabled the lookup is served by the certificates primary key. The full
byte-identical postimage proof against the original per-hand path still runs
with the fix installed.
