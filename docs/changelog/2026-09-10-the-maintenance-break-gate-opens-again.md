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

## Outcome, 07:53-08:10 UTC

The 07:53 announcement went through on its first attempt. The durable row was
written 1.2 seconds after the announcement instant
(`announced_at 07:53:00.001`, `updated_at 07:53:01.204`), `/health` reported
`durableConfirmed: true`, the countdown started at 07:55, and deploy run
34449341468 walked straight through the gate it had been sitting at since
07:30: cut over, verified, promoted, sealed. Production moved from 56962e04
to 86aab0e645 - twenty-two commits, four hours of catch-up, including #4107,
#4112, #4115, #4126 and #4136.

What the deploy fixed on arrival, measured rather than assumed:

- Hand projection restarted and began draining immediately: 2,486 hands
  projected during the break itself, 22,894 by 08:10, outbox depth down from
  132,542 to 113,123 and falling at about 1,350 rows a minute net of inflow.
- The wake counters read `local=257 realtime=257` one minute after play
  resumed, which is the evidence that let `hand_projection_outbox` leave the
  Realtime publication (migration 20260910080137). After the drop, `realtime`
  froze at 590 and the drain carried on unchanged on local wakes.
- The terminal-replay retry storm stopped. Two COMPLETED heads-up PLO4
  tournaments had produced 9,252 `terminal replay parameters disagree with
stored receipt` errors in the 07:00-07:42 window; between 08:01 and 08:10
  there were none. Both had 0 active players and settled money throughout -
  the loop was noise, not loss.
- `bounty ledger names a mismatched obligation generation`: 113 in the
  pre-deploy window, 0 after.

Engine after the cutover: `liveness ok`, `settlementStatus ok`,
`stalledTableCount 0`, `blockedSettlementCount 0`, leader elected, 698 hands
in the deal-rate window.

Database load during the backlog drain, sampled over 70 quarter-second ticks:
2.60 busy backends against 8 cores, 32.5%. Before this whole effort started
it was 3.3-3.7 busy against 4 cores, 83-93%.

## The next thing to fix, with its evidence

The global settlement lane is still global. #4135 set out to make the lane
per-tournament, and `fn_ca_lock_settlement_lane_for_tournament` does take a
per-tournament key - but only after taking the platform-wide key
`ca:tournament-terminal-settlement:v1` exclusively, and an
`pg_advisory_xact_lock` is held to commit. So every hand settlement, every
rolling authority and every seat-exit still queues behind one key, and the
per-tournament scoping underneath it buys nothing yet.

Measured on production at 08:09 over 80 quarter-second samples of that key:
held in 89% of samples, a queue present in 78.8% of them, 2.55 waiters on
average, 5 at peak, and the longest single wait 6.6 seconds. Postgres logged
dozens of `still waiting for ExclusiveLock on advisory lock
[5,4265093629,1253463894,1] after 10000.xxx ms` entries in the 08:01-08:10
window alone. The waiters seen were `fn_claim_tournament_bounty_elimination`,
`fn_seat_horse_in_seat_first_game`, `process_tournament_rebuy` and
`fn_training_cache_run_drift_audit`.

This was deliberately NOT fixed here, because the global key is not only a
mutex: three trigger guards read it as proof of authority -
`fn_tournament_live_seat_acquisition_requires_authority` (`v_owns_global`),
`fn_tournament_payouts_are_append_only` (`v_owns_terminal_root`) and
`fn_satellite_target_player_provenance_is_immutable`
(`v_owns_acquisition_root`). Dropping it from the rolling path would make
those guards refuse live seat acquisitions and payout writes. The real fix -
teaching the guards to accept the per-tournament key as proof, then taking
the global key shared on the rolling path - is a designed change to a money
path and belongs with #4135's own tests, not to a passing repair of the
deploy gate.
