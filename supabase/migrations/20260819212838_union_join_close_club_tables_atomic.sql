-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819212838 "union_join_close_club_tables_atomic"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8f709213f611955b9697377a576a9759 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- ATOMIC "CLOSE CLUB TABLES TO JOIN A UNION" (2026-08-19, audit fix pass 6)
--
-- Replaces the JS loop in /api/club-arena/union-application (approve), which
-- had four defects, all money-critical:
--   1. NOT ATOMIC — refunds were issued one seat at a time over separate
--      round-trips. A failure midway left earlier players credited in their
--      wallet AND still holding the same chips on a live table (seats were
--      only vacated after the loop). Chips existed twice. The error message
--      even claimed "nothing was changed for this table".
--   2. RESURRECTION — tables were closed with status only. The engine boot
--      sweep (GameServer.cleanupStaleData) flips closed -> waiting for every
--      cash table, and HorseFleetManager re-activates by name, so the club's
--      tables came back AFTER it joined the union, club-owned and
--      union-invisible: exactly the orphan state this project removed.
--      Closing must set is_deleted, which both sweeps skip.
--   3. PRIVATE GAMES DESTROYED — the query closed every open table including
--      is_private ones, which the rules explicitly let a club keep.
--   4. SILENT NO-REFUND — the seats query error was never checked; on error
--      the table was still closed and vacated, confiscating stacks.
--
-- One transaction, refund-then-vacate-then-close, private games preserved.
-- Refund idempotency key matches the engine's own cash-out key.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_union_close_club_tables_for_join(
  p_club_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
  v_tables int := 0;
  v_seats int := 0;
  v_refunded numeric := 0;
  v_live_tourneys int;
  v_closed jsonb := '[]'::jsonb;
BEGIN
  IF p_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing_club_id');
  END IF;

  -- Live NON-PRIVATE tournaments cannot be auto-migrated: they must finish or
  -- be cancelled by a human before the club can join.
  SELECT count(*) INTO v_live_tourneys
    FROM tournaments
   WHERE club_id = p_club_id
     AND COALESCE(is_private, false) = false
     AND status IN ('ANNOUNCED','SCHEDULED','REGISTERING','LATE_REG','RUNNING');

  IF v_live_tourneys > 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'live_tournaments',
                              'live_tournaments', v_live_tourneys);
  END IF;

  -- Refund every seated player from their ACTUAL stack, then vacate, then
  -- close. All inside this function's single transaction.
  FOR r IN
    SELECT t.id AS table_id, t.name
      FROM tables t
     WHERE t.club_id = p_club_id
       AND t.tournament_id IS NULL
       AND COALESCE(t.is_private, false) = false   -- private club games are kept
       AND COALESCE(t.is_deleted, false) = false
       AND t.status NOT IN ('closed','deleted')
     FOR UPDATE
  LOOP
    FOR r IN
      SELECT ts.id AS seat_id, ts.user_id, ts.stack, ts.table_id
        FROM table_seats ts
       WHERE ts.table_id = r.table_id AND ts.left_at IS NULL AND ts.stack > 0
       FOR UPDATE
    LOOP
      PERFORM atomic_credit_wallet_and_log(
        r.user_id, r.stack, 'cashout',
        'Table closed: club joined a union',
        r.table_id, NULL, r.seat_id, 'cashout:' || r.seat_id::text
      );
      v_seats := v_seats + 1;
      v_refunded := v_refunded + r.stack;
    END LOOP;
  END LOOP;

  UPDATE table_seats ts
     SET left_at = now()
    FROM tables t
   WHERE t.id = ts.table_id
     AND t.club_id = p_club_id
     AND t.tournament_id IS NULL
     AND COALESCE(t.is_private, false) = false
     AND COALESCE(t.is_deleted, false) = false
     AND t.status NOT IN ('closed','deleted')
     AND ts.left_at IS NULL;

  -- is_deleted is what makes the closure survive the engine boot sweep and
  -- the fleet name-match reactivation.
  WITH closed AS (
    UPDATE tables
       SET status = 'closed', current_players = 0, is_deleted = true
     WHERE club_id = p_club_id
       AND tournament_id IS NULL
       AND COALESCE(is_private, false) = false
       AND COALESCE(is_deleted, false) = false
       AND status NOT IN ('closed','deleted')
    RETURNING id, name
  )
  SELECT count(*), COALESCE(jsonb_agg(jsonb_build_object('id', id, 'name', name)), '[]'::jsonb)
    INTO v_tables, v_closed FROM closed;

  RETURN jsonb_build_object(
    'success', true,
    'tables_closed', v_tables,
    'seats_refunded', v_seats,
    'chips_refunded', v_refunded,
    'tables', v_closed
  );
END $$;

REVOKE ALL ON FUNCTION fn_union_close_club_tables_for_join(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_union_close_club_tables_for_join(uuid) TO service_role;
