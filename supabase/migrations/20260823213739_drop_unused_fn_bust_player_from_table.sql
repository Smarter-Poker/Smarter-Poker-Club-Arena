-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260823213739 "drop_unused_fn_bust_player_from_table"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e1306687edf5a99fec148e8cec0d226f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- fn_bust_player_from_table was added 2026-08-23 alongside the seat-lifecycle
-- work and never acquired a caller: the engine already releases the busted
-- player's seat inline (TournamentManagerEliminations) and then calls
-- fn_sync_seat_first_player_count to re-derive the counters. Keeping a second,
-- unreferenced way to do the same thing is how two bust paths drift apart.
-- Dropped rather than wired, because the inline path is the one the engine
-- actually runs and it is already correct.
DROP FUNCTION IF EXISTS public.fn_bust_player_from_table(uuid, uuid);
