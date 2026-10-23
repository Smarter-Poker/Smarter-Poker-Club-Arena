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
