-- ============================================================================
-- 20260824020200_reconcile_tournament_denormals.sql
-- TIER: 1 | AFFECTS: new fn_reconcile_tournament_denormals + a per-minute
--                    cron job. Data reconciliation only; no schema change.
--
-- SOURCE-CONTROL NOTE: applied directly to production 2026-08-24. This file is
-- the missing source of truth for what is already running.
--
-- TWO DENORMALISED COLUMNS THAT CANNOT KEEP THEMSELVES HONEST
--
-- A one-time backfill fixed both and both drifted straight back within the
-- hour - 0 -> 245 lying table_id rows, 0 -> 124 stale stakes strings. Expected:
-- the WRITERS are engine code, and until that deploy lands every new
-- tournament re-introduces both.
--
-- 1. tournament_players.table_id
--    createTablesAndSeatPlayers writes the table_seats row and stops, leaving
--    table_id NULL for the whole start-seated field. Measured: 297 live
--    entrants, 297 genuinely holding a seat, 166 with table_id NULL. Every
--    feature that navigates by that column - notably TournamentDetails'
--    "go to my table" - resolved to /table/undefined for those players.
--
-- 2. tables.stakes
--    Written once at table creation as the LEVEL-1 blinds and never updated,
--    while advanceBlindLevel moves small_blind/big_blind every level. A table
--    at 750/1500 kept advertising "25/50"; since a seat's depth badge is
--    stack / bigBlind, every stack was shown at the wrong multiple.
--
-- seat_number is FORCED, not COALESCEd: preferring the existing value would
-- keep a stale seat number after a table move - the identical denormalisation
-- failure this exists to correct for table_id.
--
-- trim_scale() matches the engine's own format. small_blind is numeric(_,2),
-- so ::text renders "384000.00" while the engine writes "384000" from a JS
-- number. Without it the two writers fight over the column forever.
--
-- Becomes a no-op the moment the engine deploy lands.
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

DO $$
BEGIN
  PERFORM cron.unschedule('reconcile-tournament-denormals');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'reconcile-tournament-denormals',
  '* * * * *',
  $job$
  select case
           when pg_try_advisory_lock(hashtext('reconcile-tournament-denormals'))
           then (select public.fn_reconcile_tournament_denormals()::text)
           else 'skipped'
         end;
  $job$
);
