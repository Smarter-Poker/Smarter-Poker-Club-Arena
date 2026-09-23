# Thirty-one migrations the rebuild had lost

`ea498c1fab` ("Restore September 13 … baseline", #4711) returned 1,568 files to
the September 13 baseline. 100 of those were migrations. Seventy have since
re-landed; **thirty-one never did**, and nothing noticed, because the check that
would have noticed reports without blocking and only looks back seven days.
These are eight to ten days old.

## What was actually lost, and what was not

The database was never rolled back. Of the 53 objects those thirty-one
migrations declare - 42 functions and 11 tables - **52 exist in production
right now.**

The single exception is `bulk_update_position_stats`, and its absence is
correct. That file is a tombstone: its DDL is commented out and its header says
"RETIRED - NEVER APPLIED", because its version `20260312002` collides with
`20260312002_tournament_flights.sql` and Supabase keys `schema_migrations` on
the version, so the second of two files sharing one is silently never applied.
Position stats are written by the `hand_history_position_stats` trigger into
`fn_process_hand_position_stats` and repaired by `fn_backfill_position_stats` -
all three confirmed live. Applying the retired file would add a second,
unsynchronised writer to the same counters.

So there is **no functional loss**. What was lost is the repo's copy of what
production actually ran.

## Why that still matters

From `scripts/ci/check-applied-migrations-are-recorded.mjs`, which exists for
precisely this:

> A Midway Union master reset rebuilds from these files. An applied migration
> with no file is a hardening the production database has and the rebuild does
> not - which is the one difference nobody would find until the money moved.

Thirty of these are hardenings production has and a rebuild from this repo did
not: the sponsor billing and advert-placement RPCs, the chip-statement page
cursor and its two refusal paths, `fn_union_integrity_sweep`, the rake rollup
deadline, waitlist offer capacity, tournament finish incident identity, the spin
prize audit's funded-overlay observation, referral code collisions, the video
library inventory, and the whole horse observation-capture and tuner-study
estate - eleven tables and their claim, finish, prune and evidence functions.

## Restored exactly as they ran

Every file is byte-identical to its pre-restoration blob. They are not rewritten
or "modernised", because the repo's job here is to say what production actually
executed, and an improved copy would be a third version of the truth.

Nothing in this change touches the database. No workflow applies migrations on
merge - there is no `supabase db push` anywhere in `.github/workflows` - so
restoring a file cannot replay it.

`tests/a-position-stat-has-a-live-writer.law.test.ts` and its law doc came back
too; they are what pins the tombstone above, and they were deleted with it.

## One thing this does not fix

Thirty of the thirty-one versions are **absent from
`supabase_migrations.schema_migrations`** in production, even though their
objects are live. They were applied out of band rather than through the
recorded path - the same shape the check's own header describes ("89 migrations
applied since 14:00 UTC, 49 of them had no file on origin/main").

That means production's migration history understates what production has run.
Recording those thirty rows is a separate, deliberate act against the live
history table, and it wants its own change with its own readback rather than
riding along with a file restore. It is written down here so the next reader
finds it instead of rediscovering it.
