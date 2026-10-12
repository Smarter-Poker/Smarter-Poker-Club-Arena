-- ============================================================================
-- A DELETED BOARD GAME IS CHECKED BY INDEX
-- ============================================================================
--
-- WHAT WAS WRONG, MEASURED ON PRODUCTION 2026-10-03 21:00-22:00 UTC
--
-- fn_ca_retire_welcome_certification_club (the certification cleanup the
-- production e2e and club-create certification runs call) took 7.2 s on
-- average and up to 13.2 s (9 calls in the hour, pg_stat_statements). Its
-- board steps take the platform entry/maintenance lock
-- pg_advisory_xact_lock(530090,1) EXCLUSIVE and keep it to COMMIT, so every
-- fn_publish_tournament_blind_level, seat-first creation, horse seat and
-- tournament launch on the platform (all of which take that key SHARED)
-- waits for the whole cleanup: ~22 blind-publish statement timeouts per
-- 10 minutes while a cleanup runs.
--
-- Most of that time is foreign-key checks. The cleanup deletes the welcome
-- board's tournaments, tables and cash games (a welcome package is 10
-- items). Deleting a referenced row makes Postgres look for referencing rows,
-- and three referencing columns have no index, so each check is a full scan:
--
--   tournaments -> tournament_refund_entitlements.source_satellite_id
--                  597,826 rows (2,110 non-null), 143 MB   140-226 ms per tournament
--   tables      -> cash_seat_moves.to_table_id (ON DELETE CASCADE)
--                  201,400 rows, 45 MB                     121-193 ms per table
--   cash_games  -> cash_seat_moves.game_id (ON DELETE CASCADE)
--                                                           184 ms per cash game
--
-- (each measured on production as the exact FK lookup, single process).
-- Ten to twenty deletes per cleanup is 2-5 s of the lock hold spent scanning.
--
-- THE FIX
--
-- Index the three referencing columns, built CONCURRENTLY (no table lock on
-- the live seat-move or refund writers), then verify them in one short
-- transaction. The refund index is partial on NOT NULL: 2,110 of 597,826 rows
-- carry a source satellite, and an equality lookup (the FK check) implies
-- NOT NULL, so the planner uses it. The cleanup's lock, order, refusals and
-- every row it touches are unchanged; it simply stops scanning. The builds
-- are small (at most 201,400 uuids) and need no work_mem or
-- maintenance_work_mem increase.
-- ============================================================================

-- @live-proof: (SELECT count(*) = 3 AND bool_and(indisvalid AND indisready AND indislive) FROM pg_index WHERE indexrelid IN (to_regclass('public.idx_tournament_refund_entitlements_source_satellite'), to_regclass('public.idx_cash_seat_moves_to_table'), to_regclass('public.idx_cash_seat_moves_game')))

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tournament_refund_entitlements_source_satellite
  ON public.tournament_refund_entitlements (source_satellite_id)
  WHERE source_satellite_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cash_seat_moves_to_table
  ON public.cash_seat_moves (to_table_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cash_seat_moves_game
  ON public.cash_seat_moves (game_id);

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $verify$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(e.name, ', ') INTO v_bad
    FROM (VALUES ('idx_tournament_refund_entitlements_source_satellite'),
                 ('idx_cash_seat_moves_to_table'),
                 ('idx_cash_seat_moves_game')) e(name)
    LEFT JOIN pg_index i ON i.indexrelid = to_regclass('public.' || e.name)
   WHERE i.indexrelid IS NULL OR NOT (i.indisvalid AND i.indisready AND i.indislive);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'certification FK indexes missing or invalid: %', v_bad USING ERRCODE = '55000';
  END IF;
END
$verify$;

COMMENT ON INDEX public.idx_tournament_refund_entitlements_source_satellite IS
  'FK check for tournaments -> tournament_refund_entitlements.source_satellite_id (a deleted tournament was a 143 MB scan).';
COMMENT ON INDEX public.idx_cash_seat_moves_to_table IS
  'FK check for tables -> cash_seat_moves.to_table_id (a deleted table was a 45 MB scan).';
COMMENT ON INDEX public.idx_cash_seat_moves_game IS
  'FK check for cash_games -> cash_seat_moves.game_id (a deleted cash game was a 45 MB scan).';

COMMIT;
