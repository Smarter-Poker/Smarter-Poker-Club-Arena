-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830201117; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- current_players drifted one ahead of the actual field on the relaunched
-- Main Event: 116 counted, 115 tournament_players rows, all 'registered'.
--
-- The counter is maintained by increments in several writers
-- (fn_register_for_tournament, fn_award_satellite_seat) rather than derived,
-- so any writer that increments without a surviving row leaves it high. This
-- is the same read-modify-write hazard the 2026-08-19 multi-table audit fixed
-- in the satellite path by recounting from tournament_players instead of
-- adding to a stale snapshot; here the count is simply reconciled to truth.
--
-- It matters because current_players is what the lobby shows as the entrant
-- count and what the capacity guard in fn_award_satellite_seat compares
-- against max_players — an inflated count turns players away from a table
-- that has room.

DO $$
DECLARE
  v_tid    uuid := 'dfae9288-40e2-485d-8c97-a13dd53ab483';
  v_actual int;
  v_before int;
BEGIN
  SELECT current_players INTO v_before FROM tournaments WHERE id = v_tid;
  SELECT count(*) INTO v_actual FROM tournament_players WHERE tournament_id = v_tid;

  UPDATE tournaments
     SET current_players = v_actual, updated_at = now()
   WHERE id = v_tid;

  PERFORM 1 FROM tournaments t
   WHERE t.id = v_tid
     AND t.current_players = (SELECT count(*) FROM tournament_players WHERE tournament_id = v_tid);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entrant count did not reconcile';
  END IF;

  RAISE NOTICE 'Entrant count reconciled % -> %.', v_before, v_actual;
END $$;
