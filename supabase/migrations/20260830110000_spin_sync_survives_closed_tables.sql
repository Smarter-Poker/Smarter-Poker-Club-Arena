-- ============================================================================
-- 20260830110000_spin_sync_survives_closed_tables.sql
-- TIER: 2 | AFFECTS: fn_sync_seat_first_player_count, zombie spin rows.
-- Applied to production via the Supabase MCP on 2026-08-30. This file is the
-- repo's replayable record.
--
-- BUG (2026-08-30 spins audit): fn_sync_seat_first_player_count resolves the
-- primary table via fn_tournament_primary_table, which excludes CLOSED
-- tables. When a REGISTERING spin's only table is closed (drain/eviction
-- vacated every seat and closed the table in the same sweep), the function
-- returned NULL WITHOUT touching tournaments.current_players. Observed live:
-- spin b5ee9c99 stuck at 3/3 with zero live seats since 09:03 UTC - the
-- lobby advertised a full game forever, nobody could join, the fleet never
-- replaced the tier, and 5 Chip PLO5 spins were offline for the day.
--
-- FIX: with no open table, a seat-first tournament still resyncs its counter
-- from live seats across ALL its tables. REPAIR: unfillable zombies (all
-- tables closed, zero live seats, no players, no registrations, no buy-in
-- ledger evidence) are cancelled via atomic_cancel_tournament - the guard
-- trigger trg_tournaments_cancel_must_refund requires that path so refunds
-- would run if there were any (there are none for these).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_sync_seat_first_player_count(p_tournament_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_table uuid;
  v_seats integer := 0;
  v_seat_first boolean := false;
BEGIN
  SELECT (COALESCE(t.variant, '') IN ('spin', 'sng') OR COALESCE(t.max_players, 0) <= 2)
    INTO v_seat_first
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;

  v_table := public.fn_tournament_primary_table(p_tournament_id);

  IF v_table IS NULL THEN
    -- Every table is closed (or none exists). The old body returned here
    -- without writing anything, which is how a vacated spin kept reading
    -- 3/3 forever. A seat-first tournament's counter still derives from
    -- its live seats - across all its tables - and with them all closed
    -- that number is the honest zero.
    IF COALESCE(v_seat_first, false) THEN
      SELECT count(*) INTO v_seats
        FROM public.table_seats s
        JOIN public.tables tb ON tb.id = s.table_id
       WHERE tb.tournament_id = p_tournament_id
         AND s.left_at IS NULL;
      UPDATE public.tournaments SET current_players = v_seats WHERE id = p_tournament_id;
      RETURN v_seats;
    END IF;
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_seats
    FROM public.table_seats
   WHERE table_id = v_table AND left_at IS NULL;

  UPDATE public.tables SET current_players = v_seats WHERE id = v_table;

  IF COALESCE(v_seat_first, false) THEN
    UPDATE public.tournaments SET current_players = v_seats WHERE id = p_tournament_id;
  END IF;

  RETURN v_seats;
END;
$function$;

DO $$
DECLARE
  g record; v_cancelled int := 0; v_failed int := 0; res jsonb;
BEGIN
  FOR g IN
    SELECT t.id FROM public.tournaments t
     WHERE t.variant = 'spin'
       AND t.status IN ('REGISTERING','ANNOUNCED')
       AND NOT EXISTS (SELECT 1 FROM public.tables tb
                        WHERE tb.tournament_id = t.id
                          AND lower(COALESCE(tb.status,'')) <> 'closed')
       AND EXISTS (SELECT 1 FROM public.tables tb WHERE tb.tournament_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.table_seats s
                        JOIN public.tables tb ON tb.id = s.table_id
                       WHERE tb.tournament_id = t.id AND s.left_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.tournament_registrations r WHERE r.tournament_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public.wallet_transactions w
                       WHERE w.related_entity_id = t.id AND w.category = 'tournament_buyin')
  LOOP
    BEGIN
      res := public.atomic_cancel_tournament(g.id, NULL);
      v_cancelled := v_cancelled + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      RAISE WARNING 'could not cancel zombie spin %: %', g.id, SQLERRM;
    END;
    -- Whether or not the cancel succeeded, the counter must tell the truth.
    PERFORM public.fn_sync_seat_first_player_count(g.id);
  END LOOP;
  RAISE NOTICE 'spin_sync_survives_closed_tables: cancelled % zombie spin(s), % failed', v_cancelled, v_failed;
END $$;

-- Definer Authorization (added same day, applied as 20260830114000): this is
-- a SECURITY DEFINER writer with no auth check - it is the ENGINE's resync
-- primitive, never a browser's.
REVOKE ALL ON FUNCTION public.fn_sync_seat_first_player_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sync_seat_first_player_count(uuid) TO service_role;
