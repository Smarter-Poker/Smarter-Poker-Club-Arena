-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827155010; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- THE SEAT-FIRST COUNT SYNC MUST ONLY RUN FOR SEAT-FIRST FORMATS — 2026-08-27
--
-- fn_sync_seat_first_player_count sets tournaments.current_players to the live
-- seat count AT THE PRIMARY TABLE. That is correct for a Spin or a heads-up
-- SNG, which have exactly one table. The engine calls it on EVERY bust in
-- EVERY format (releaseTournamentSeat), so a multi-table MTT had its entrant
-- count overwritten with one table's seat count on every elimination:
--   * a RUNNING 43-entrant, 2-table event read current_players = 6
--   * every completed MTT today ends at 1
-- fn_reconcile_tournament_denormals already restricts this rule to
--   variant IN ('spin','sng') OR max_players <= 2
-- and never repairs COMPLETED rows, so the wrong numbers were permanent.
--
-- Consequences fixed: fn_register_for_tournament's `tournament_full` cap
-- becomes enforceable again during late registration, ca_club_tournaments
-- stops reporting "1 player" for a 45-player event, and fn_spin_sweep_unbooked
-- (which settles off current_players) can no longer be handed an MTT's
-- clobbered counter.
--
-- The guard lives HERE rather than at the call site so every caller — engine,
-- sweeps, future code — inherits it. Seat-first callers are unaffected.
-- ═══════════════════════════════════════════════════════════════════════════

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

  -- Multi-table formats: the table's own counter is still worth refreshing,
  -- but the TOURNAMENT's entrant count is not this function's business.
  v_table := public.fn_tournament_primary_table(p_tournament_id);
  IF v_table IS NULL THEN
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
