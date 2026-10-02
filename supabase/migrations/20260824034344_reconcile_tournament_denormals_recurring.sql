-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260824034344 as "reconcile_tournament_denormals_recurring"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- ============================================================================
-- TWO DENORMALISED COLUMNS THAT CANNOT KEEP THEMSELVES HONEST (2026-08-24)
--
-- A one-time backfill fixed both of these earlier today and both drifted
-- straight back - 0 -> 245 lying table_id rows and 0 -> 124 stale stakes
-- strings within the hour. That is expected: the WRITERS are in engine code
-- (TournamentManagerBase.createTablesAndSeatPlayers and advanceBlindLevel),
-- the corrections to those writers are committed but not yet deployed to the
-- engine host, so every new tournament re-introduces both.
--
-- 1. tournament_players.table_id
--    createTablesAndSeatPlayers writes the table_seats row and stops, leaving
--    table_id NULL for the whole start-seated field. Everything that navigates
--    by that column - notably TournamentDetails' "go to my table" - resolves to
--    /table/undefined for those players.
--
-- 2. tables.stakes
--    Written once at table creation as the LEVEL-1 blinds and never updated,
--    while advanceBlindLevel moves small_blind/big_blind on every level. A
--    table at 750/1500 kept advertising "25/50", and any reader that trusts
--    `stakes` for stack depth reports every stack at the wrong multiple.
--
-- This reconciles both from the rows that are actually true (table_seats, and
-- the table's own numeric blind columns). It is a safety net, not the fix: it
-- becomes a no-op the moment the engine deploy lands, because there will be
-- nothing left to correct.
--
-- trim_scale() matches the engine's own format: small_blind is numeric(_,2),
-- so ::text renders "384000.00" while the engine writes "384000" from a JS
-- number. Without it the two writers would fight over the column forever.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_reconcile_tournament_denormals()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_roster int := 0;
  v_stakes int := 0;
BEGIN
  WITH live_seat AS (
    SELECT s.user_id, tb.tournament_id, s.table_id, s.seat_number,
           ROW_NUMBER() OVER (
             PARTITION BY tb.tournament_id, s.user_id ORDER BY s.joined_at DESC NULLS LAST
           ) AS rn
      FROM public.table_seats s
      JOIN public.tables tb ON tb.id = s.table_id
     WHERE s.left_at IS NULL AND tb.tournament_id IS NOT NULL
  ), upd AS (
    UPDATE public.tournament_players tp
       SET table_id = ls.table_id, seat_number = ls.seat_number
      FROM live_seat ls
     WHERE ls.rn = 1
       AND tp.tournament_id = ls.tournament_id
       AND tp.user_id = ls.user_id
       AND tp.status IN ('registered', 'playing')
       AND (tp.table_id IS DISTINCT FROM ls.table_id
         OR tp.seat_number IS DISTINCT FROM ls.seat_number)
    RETURNING 1
  ) SELECT count(*) INTO v_roster FROM upd;

  WITH upd2 AS (
    UPDATE public.tables tb
       SET stakes = trim_scale(tb.small_blind)::text || '/' || trim_scale(tb.big_blind)::text
      FROM public.tournaments t
     WHERE t.id = tb.tournament_id
       AND t.status IN ('RUNNING', 'REGISTERING', 'ANNOUNCED')
       AND tb.small_blind IS NOT NULL
       AND tb.big_blind IS NOT NULL
       AND tb.stakes IS DISTINCT FROM
           (trim_scale(tb.small_blind)::text || '/' || trim_scale(tb.big_blind)::text)
    RETURNING 1
  ) SELECT count(*) INTO v_stakes FROM upd2;

  RETURN jsonb_build_object('roster_rows_fixed', v_roster, 'stakes_rows_fixed', v_stakes);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_reconcile_tournament_denormals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_reconcile_tournament_denormals() TO postgres;
GRANT EXECUTE ON FUNCTION public.fn_reconcile_tournament_denormals() TO service_role;
