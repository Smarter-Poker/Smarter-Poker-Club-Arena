-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819032249 "close_seats_stranded_by_cancelled_tournaments"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 786d8c34c7d46273feedb42d9b24846b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Dan 2026-08-19: the boot sweep that cancelled live SNG/Spin tournaments left
-- seats behind. Cancelling closed each tournament's tables but did not always
-- release the seat rows, so `table_seats.left_at` stayed NULL on a CLOSED table
-- belonging to a CANCELLED tournament. Those rows make a departed player look
-- permanently seated: they inflate "online" counts and can block the seat.
--
-- This closes only rows that are unambiguously dead: table CLOSED *and*
-- tournament CANCELLED. Live tables and live tournaments are untouched.
DO $$
DECLARE
  v_seats   int;
  v_players int;
  v_leaked  int;
BEGIN
  UPDATE table_seats s
     SET left_at = COALESCE(tr.ended_at, now())
    FROM tables t
    JOIN tournaments tr ON tr.id = t.tournament_id
   WHERE s.table_id = t.id
     AND s.left_at IS NULL
     AND t.status = 'closed'
     AND tr.status = 'CANCELLED';
  GET DIAGNOSTICS v_seats = ROW_COUNT;

  -- Same story on the tournament roster: entrants left in registered/playing
  -- on a cancelled tournament never reach a terminal state.
  UPDATE tournament_players tp
     SET status = 'eliminated'
    FROM tournaments tr
   WHERE tr.id = tp.tournament_id
     AND tr.status = 'CANCELLED'
     AND tp.status IN ('registered', 'playing');
  GET DIAGNOSTICS v_players = ROW_COUNT;

  RAISE NOTICE 'Released % stranded seat(s), closed % stranded tournament player row(s)',
    v_seats, v_players;

  -- Assert the leak is actually gone; abort if anything remains.
  SELECT count(*) INTO v_leaked
    FROM table_seats s
    JOIN tables t ON t.id = s.table_id
    JOIN tournaments tr ON tr.id = t.tournament_id
   WHERE s.left_at IS NULL AND t.status = 'closed' AND tr.status = 'CANCELLED';

  IF v_leaked > 0 THEN
    RAISE EXCEPTION 'Still % seat(s) stranded on cancelled tournaments', v_leaked;
  END IF;
END $$;
