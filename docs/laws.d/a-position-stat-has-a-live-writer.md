# tests/a-position-stat-has-a-live-writer.law.test.ts

`bulk_update_position_stats` was declared by a migration whose version
collided with `20260312002_tournament_flights.sql`, so it was never applied
and 405 `[PositionStats]` reports in March 2026 were one PGRST202 each. The
write path that actually survives is the `hand_history_position_stats`
trigger calling `fn_process_hand_position_stats`, and that trigger swallows
every exception with RAISE WARNING - so losing the function loses the stats
page in silence. This pins the table, the trigger function and the backfill
function as present in the schema manifest, keeps the retired RPC from
acquiring a new caller, and keeps the stranded migration marked RETIRED so it
is not read as a shipped object a third time.
