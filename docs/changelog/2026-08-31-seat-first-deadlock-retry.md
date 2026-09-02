# 2026-08-31 - seat-first count sync survives a deadlock

Migration: `supabase/migrations/20260831115135_seat_first_count_sync_survives_a_deadlock.sql`
(already applied to production as `20260831115135`; this commit only records it in the repo).

## What was wrong

`public.fn_sync_seat_first_player_count(uuid)` updates `public.tables` and then
`public.tournaments`. Concurrent writers on the seating path take those same two
relations in the opposite order, so under real load the pair deadlocks, Postgres
kills whichever transaction it picks, and the engine logs

    seat-first count sync failed for tournament <id>: deadlock detected

The counter is then simply not written, and the function gives up.

## Why it surfaced now

The deadlock is not new; the traffic that exposes it is. Deadlocks ran at a
1-4/hour baseline for days, then rose to 13/hour at 08:00 and 27/hour at 10:00 -
the hours in which the horse fleet and the SNG board came back to life. Spins
went from 3-10/hour to 150/hour, and 28 SNGs were created in an hour after 16
hours of zero. The failure was already visible at low volume in the 03:30-08:53
window, before any of today's changes.

## Impact

Not a correctness bug today. `reconcile-tournament-denormals` runs every minute
and the function recomputes from scratch, so a lost run is repaired by the next
one. Measured zero `current_players` drift both before and after the fix: no
live SNG or SPIN tournament had a counter disagreeing with its live seat count.
What it was costing was wasted work and log noise that hides real failures, and
it becomes a correctness bug the moment something reads the counter between a
failure and the next sweep.

## The fix

The function is idempotent by construction - both counters are derived from a
`COUNT(*)`, so a re-attempt cannot double-count. A PL/pgSQL `EXCEPTION` block
opens a subtransaction, so `40P01` can be caught and the work re-attempted
without poisoning the caller's transaction. It now retries up to three times,
with a short backoff, then gives up exactly as before and defers to the
every-minute denormal sweep.

Lock ORDER was deliberately left alone: reordering the two UPDATEs here would
only move the inversion to whichever writer currently agrees with this one.

## One deviation from the applied SQL, and why

The file is byte-for-byte the SQL that ran in production for its first 7117
bytes (md5 `b6d00aecd56765c62440f656682a7e1e`, computed in Postgres over
`supabase_migrations.schema_migrations`). Two lines are appended:

    REVOKE ALL ON FUNCTION public.fn_sync_seat_first_player_count(uuid) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.fn_sync_seat_first_player_count(uuid) TO service_role;

They change nothing. `CREATE OR REPLACE` does not reset an ACL, so the applied
migration did not need them, and production already reads
`{postgres=X/postgres,service_role=X/postgres}` - no browser role can call this
function. They are here because `scripts/ci/check-definer-authorization.mjs`
models grants from the migration file alone, starting at the Postgres default
where PUBLIC holds EXECUTE, and correctly blocks a SECURITY DEFINER writer that
never consults `auth.uid()`. This is the gate's own remedy 1, copied verbatim
from `20260830110000_spin_sync_survives_closed_tables.sql`, the previous
migration for this same function. Nothing was allowlisted and no gate was
weakened.

`fn_sync_seat_first_player_count` was already present in
`scripts/ci/supabase-schema-manifest.json`, so no manifest change was needed.
