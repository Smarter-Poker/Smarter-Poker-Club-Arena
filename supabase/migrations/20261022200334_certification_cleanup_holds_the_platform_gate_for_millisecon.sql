-- 20261022200334_certification_cleanup_holds_the_platform_gate_for_millisecon.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_ca_retire_welcome_certification_club ran 10-22 s per call on 2026-10-22
-- (auto_explain: 21.8, 16.0, 14.6, 14.3, 13.2, 12.5, 11.6, 11.1, 10.1 s), and
-- its first step takes the platform gate pg_try_advisory_xact_lock(530090,1)
-- EXCLUSIVELY to the end of the transaction. Every buy-in, registration,
-- rebuy, add-on, late seat and blind-level publish on the platform takes that
-- gate shared, so each certification cleanup froze entry platform-wide: the
-- 8 s statement timeouts on fn_publish_tournament_blind_level and the entry
-- RPCs line up minute for minute with the cleanups (16:03, 16:29, 16:53,
-- 17:16, 18:02, 18:21, 19:15 UTC).
--
-- The work under the gate was slow for two reasons, measured read-only:
--   1. tournaments.schedule_id had no index (3,443 of 819k rows set), so five
--      lookups each read the whole table (1.2 s serial each), and the
--      board-games lock statement read the whole primary key (2.0 s) because
--      a correlated EXISTS inside its OR ruled out any index plan.
--   2. Deleting the fixture's ~21 tables, 12-16 tournaments and 9 cash games
--      made Postgres check child tables per deleted row, and these foreign
--      key columns had no usable index: cash_seat_moves.from_table_id (228k),
--      tournament_seat_move_receipts.source_table_id / destination_table_id
--      (165k), smarter_private.f06_operations.source_table_id (28k),
--      tournament_manager_wakes.tournament_id (752k, partial unique index
--      only), tournament_bounties.tournament_id (73k), cash_game_roster.game_id
--      (159k, partial only), and the explicit table_pending_addons(table_id)
--      check (60k). 20-150 ms warm and up to ~1 s cold, per deleted row.
--
-- THE FIX:
--   * the nine indexes, built CONCURRENTLY on 2026-10-22 19:46-19:48 UTC (no
--     write lock on any of these tables) and recorded here with IF NOT EXISTS
--     so a replay is a no-op. They serve every ordinary table, tournament and
--     cash-game deletion on the platform, not only the certification path;
--   * the board-games lock statement selects the rows to lock by id from
--     three index-served sets instead of one OR over the whole table. Same
--     rows, same id order, same FOR UPDATE.
-- No semantics change: the gate, its scope and its order are untouched; only
-- the time it is held shrinks.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_tournaments_schedule_id
    ON public.tournaments (schedule_id) WHERE schedule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tournament_manager_wakes_tournament_id
    ON public.tournament_manager_wakes (tournament_id);
CREATE INDEX IF NOT EXISTS idx_cash_seat_moves_from_table_id
    ON public.cash_seat_moves (from_table_id);
CREATE INDEX IF NOT EXISTS idx_tsmr_source_table_id
    ON public.tournament_seat_move_receipts (source_table_id);
CREATE INDEX IF NOT EXISTS idx_tsmr_destination_table_id
    ON public.tournament_seat_move_receipts (destination_table_id);
CREATE INDEX IF NOT EXISTS idx_f06_operations_source_table_id
    ON smarter_private.f06_operations (source_table_id);
CREATE INDEX IF NOT EXISTS idx_cash_game_roster_game_id
    ON public.cash_game_roster (game_id);
CREATE INDEX IF NOT EXISTS idx_tournament_bounties_tournament_id
    ON public.tournament_bounties (tournament_id);
CREATE INDEX IF NOT EXISTS idx_table_pending_addons_table_id
    ON public.table_pending_addons (table_id);

DO $migration$
DECLARE
  v_def text;
  v_old constant text := $old$  PERFORM 1 FROM public.tournaments t
   WHERE t.club_id=p_club_id OR t.schedule_id=ANY(v_schedules)
      OR EXISTS(SELECT 1 FROM public.tournament_schedule_spawns s
                 WHERE s.schedule_id=ANY(v_schedules) AND s.tournament_id=t.id)
   ORDER BY t.id FOR UPDATE;$old$;
  v_new constant text := $new$  -- 2026-10-22: the rows to lock come from three index-served sets; the
  -- OR over the whole table read all 819k tournaments under the platform gate.
  PERFORM 1 FROM public.tournaments t
   WHERE t.id IN (SELECT x.id FROM public.tournaments x WHERE x.club_id=p_club_id
                  UNION SELECT x.id FROM public.tournaments x
                         WHERE x.schedule_id=ANY(v_schedules)
                  UNION SELECT s.tournament_id FROM public.tournament_schedule_spawns s
                         WHERE s.schedule_id=ANY(v_schedules) AND s.tournament_id IS NOT NULL)
   ORDER BY t.id FOR UPDATE;$new$;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure);
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'board-games lock statement not found exactly once; function changed since this migration was written';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$migration$;

COMMIT;
