# Adaptive Batch Once Finds Touched Batches Through The Hand Index

## What Was Wrong

Minutes after #6883 installed on production (2026-10-15 00:08 UTC), the adaptive
retention lane stopped committing: zero hands retired in five minutes, against
about 490 per minute before, and one owner call held the capacity lock for more
than 38 seconds in `DataFileRead`.

## Cause, Read From The Plan

The once-per-batch compaction in `public.fn_prune_horse_adaptive_journal()`
finds the touched batches with `c.hand_id::text=ANY(retired_hands)`. Casting the
primary key to text cannot use `horse_adaptive_disposal_certificates_pkey`, so
every call sequentially scanned all of the roughly 3.9 million certificates
(planner cost about 813,000).

## The Fix

Migration `20261015001400_adaptive_batch_once_finds_touched_batches_through_the_hand_i.sql`
compares the uuid column to the same hands as `uuid[]`, an index scan on the
primary key (planner cost about 52). `retired_hands` only ever holds
`hand_id::text` values taken from that uuid column, so the selected rows are
identical. That one predicate is the whole change; the rest of the owner is the
installed #6883 body byte-for-byte. The migration refuses unless the installed
owner is exactly the #6883 postimage (md5 `cbc454dbbdbe7ea0bcfb629b5218dd2d`).

## Proof

`scripts/verification-harness/horse-adaptive-batch-once.py` now proves the
fixture's #6883 postimage hash equals production's, applies the repair, refuses
its replay, confirms the uuid predicate, and then runs every existing
byte-identity assertion against the repaired owner. Local native PostgreSQL 17
run: 20 checks passed.
