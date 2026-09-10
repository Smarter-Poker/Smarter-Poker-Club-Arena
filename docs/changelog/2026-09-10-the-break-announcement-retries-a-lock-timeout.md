# The break announcement retries a lock timeout

Date: 2026-09-10. Engine only; no migration.

## What happened

At 06:53:11 UTC the engine announced the :55 maintenance break and the
durable save of the last-hand row failed once:

    [MaintenanceBreak] announcement failed Error: canceling statement due to lock timeout

One failure cancelled the whole hour's break. No last-hand row, no :55
countdown, no `readyForRestart` certificate. The deploy run that had been
waiting since 06:32 (run 34445622542, target 06887cc30e) polled the gate 57
times, saw `active=False phase=idle` throughout, and recorded
`shipped=false reason=the engine never presented a complete current
readyForRestart certificate`. Production stayed on 56962e04 for another hour
with nobody told.

## Why the save times out

`fn_save_engine_maintenance_break` takes the maintenance boundary
`pg_advisory_xact_lock(530090, 1)` exclusively, under `lock_timeout=5s`.
Every entry door (`atomic_table_buyin`, `atomic_table_rebuy`,
`process_tournament_rebuy`, `fn_spin_draw_and_settle_atomic`,
`fn_seat_horse_in_seat_first_game`, `fn_cash_seat_move_execute`, and the
rest of the 530090 family) takes the same key shared for the life of its
transaction, under `statement_timeout=30s`. `pg_stat_statements` since the
02:34 reset shows `atomic_table_buyin` at a 27 s maximum and a 1.7 s mean,
`process_tournament_rebuy` at 11.9 s, `fn_seat_horse_in_seat_first_game` at
9.3 s. The exclusive request has to wait for every shared holder in flight
when it queues; one slow buy-in is enough to exceed five seconds.

## The fix

`MaintenanceBreak.announceLastHand` now persists through
`persistAnnouncement`, which retries a lock or statement timeout every 5 s
for up to 90 s from `announcedAt`. Nothing a player sees moves: the countdown
is armed from the announced `announcedAt + LAST_HAND_LEAD_MS` and the
database accepts the last-hand row until `announcedAt + 2 min`, so a save
that lands at :53:40 still counts down at :55:00. An ownership loss, an
expired boundary, or any other error still cancels on the first attempt,
exactly as before; only the queue-shaped failure is retried.

Tests: `src/maintenance/MaintenanceBreak.test.ts` gains three cases: the
retry that succeeds and keeps the announced :55; the retry budget that runs
out and cancels cleanly; and the non-retry of an ownership or boundary error.

## Left as observed

The entry doors holding the boundary for seconds at a time are their own
finding: `atomic_table_buyin` should not take 1.7 s on average. That is
recorded in `docs/changelog/2026-09-10-swarm-per-hand-cost.md` under
"Observed, not fixed" for the next pass.
