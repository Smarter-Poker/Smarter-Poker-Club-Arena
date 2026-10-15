# Horse Adaptive Compaction Finds Batches Through The Hand Id Index

## What Was Wrong

Minutes after `20261014231333` installed (2026-10-15 00:09 UTC), production
`fn_prune_horse_adaptive_journal()` (md5 `cbc454dbbdbe7ea0bcfb629b5218dd2d`)
found the batches to compact with `WHERE c.hand_id::text=ANY(retired_hands)`.
Casting the uuid primary key to text disabled
`horse_adaptive_disposal_certificates_pkey`, so every call that retired a hand
ran a parallel sequential scan of the 6.3 GB certificates table: EXPLAIN cost
841,253, and one owner call was observed reading in `DataFileRead` for more
than 50 seconds against a 2-second budget. The engine retention lane calls the
same owner continuously, so this load ran on production until corrected.

## The Fix

Migration `20261015001555_horse_adaptive_compaction_finds_batches_through_the_hand_id_.sql`
changes that one predicate to `WHERE c.hand_id=ANY(retired_hands::uuid[])`.
`retired_hands` only ever holds `candidate.hand_id::text`, so the matched set
is identical and the plan becomes a primary-key index scan (EXPLAIN cost 11).
Every other byte of the function, its budgets, capacity lock, cursor,
high-water, statistics expiry, receipt, owner, security definer, search path,
lock timeout and ACLs is unchanged. It refuses to apply unless the installed
owner is exactly the `20261014231333` postimage. No job, schedule, repair or
backfill.

## Proof

`scripts/verification-harness/horse-adaptive-batch-once.py` now installs the
correction on top of `20261014231333` in both the corrected and rollback
worlds, so every existing byte-identity, protection, idempotency and
atomicity assertion runs against the corrected owner. It also proves the
correction's replay is refused and that the installed owner finds batches
through the uuid primary key.
