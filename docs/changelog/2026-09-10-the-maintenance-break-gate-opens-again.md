# The maintenance break gate opens again

Date: 2026-09-10. One migration (20260910073818) plus the engine half in #4142.

## The hour production lost

06:32 UTC, deploy run 34445622542 built 06887cc30e and sat down to wait for
the :55 break. 06:53:11, the engine announced the break and could not write
the row:

    [MaintenanceBreak] announcement failed Error: canceling statement due to lock timeout
    [MaintenanceBreak] failed to clear the break row Error: canceling statement due to lock timeout

One timeout cancelled the whole hour. The deploy polled the gate 57 times,
read `active=False phase=idle` every time, and recorded `shipped=false
reason=the engine never presented a complete current readyForRestart
certificate`. Nothing shipped, no alert fired, and the engine stayed on
56962e04 - twenty-two commits and four hours behind.

What was sitting in those twenty-two commits mattered. #4115 gives the hand
projection a 5 s poll net. Production's Realtime channel for
`hand_projection_outbox` had entered CHANNEL_ERROR at about 03:14, and the
deployed build has no net under it, so projection stopped dead:
`hand_projection_outbox` reached 130,129 rows with the oldest four hours old
and inflow of about 577 rows a minute against a drain of zero. The fix for
that was merged and could not reach the box, because the door it reaches the
box through was the one that had jammed.

## Why the writer could not get in

`fn_save_engine_maintenance_break` is the admission serialization point. It
takes `pg_advisory_xact_lock(530090, 1)` exclusively so no entry can commit
on the wrong side of the announcement. Every entry door takes that same key
shared for the life of its transaction, and those transactions run under a
30 s `statement_timeout`. The writer was given 5 s.

Measured on production while diagnosing: a 15 s sample found the boundary
held in 59% of samples; since the 02:34 statistics reset `atomic_table_buyin`
shows 1.7 s mean and 27 s max, `process_tournament_rebuy` 11.9 s max, and
`fn_seat_horse_in_seat_first_game` 9.3 s max over 14,228 calls. Five seconds
against that is a coin flip that gets tossed once an hour.

## The two halves of the fix

The database half (migration 20260910073818) gives the four writers of the
maintenance boundary - save, clear, claim and thaw - `lock_timeout` 32s and
`statement_timeout` 35s, just past the 30 s ceiling the entry doors run
under. A serialization point has to be able to outwait the work it
serializes. Bodies, grants and search_path are untouched; the migration is
four `ALTER FUNCTION ... SET` pairs.

The engine half (#4142) makes `announceLastHand` retry a lock or statement
timeout every 5 s for up to 90 s from `announcedAt`. The announced :55 does
not move: the countdown is armed from `announcedAt + LAST_HAND_LEAD_MS` and
the database accepts a last-hand row until `announcedAt + 2 min`. An
ownership loss or an expired boundary still cancels on the first attempt.

## What it costs

A queued exclusive advisory waiter blocks the shared requests behind it, so
from the moment the announcement queues, new entries wait rather than being
admitted. That is what the announcement means - the freeze starts at :53 and
an entry arriving at :53:01 is refused as PLATFORM_FROZEN regardless. The
wait is bounded by the entry doors' own 30 s ceiling and is about 2 s in the
ordinary case. Hand settlement does not take this key, so tables keep
dealing throughout.

## Observed while here, not fixed

`atomic_table_buyin` at 1.7 s mean is its own finding: a rolled-back probe
put the individual writes at 21 ms (club_members), 19 ms (seat delete), 49 ms
(seat insert), 18 ms (wallet_transactions) and 11 ms (tables), with
`trg_club_members_audit_chip_movement` and
`trg_tables_emit_game_management_event` the largest single triggers. The
seconds are spent queueing, not working. Recorded for the next pass.
