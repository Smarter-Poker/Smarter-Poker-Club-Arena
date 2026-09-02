-- A pending close is on the board, so it must announce itself.
--
-- fn_list_managed_games projects `pending_schedule` for every game - the
-- guarded close another operator has queued, and when it will fire. Nothing
-- has ever emitted an event when that row changed: managed_game_schedules had
-- no trigger at all.
--
-- Until today that cost nothing visible, because the game emitters fired on
-- every heartbeat write and the board was reloading several times a second.
-- Scheduling a close was picked up within a fraction of a second by accident,
-- on the back of an unrelated event. Quieting those emitters
-- (a_management_event_means_the_board_changed) removes the accident, and this
-- gap becomes the observable one: operator A schedules a guarded close and
-- operator B's open board does not show it until they reload by hand.
--
-- Execution was already covered - executing a close moves `status` on the game
-- row itself, which is watched. What was uncovered is the scheduling and the
-- cancelling, which touch only this table.
--
-- Emits on the transitions the board can actually see: a row entering or
-- leaving 'scheduled', or a scheduled row's execute_at moving. A status change
-- between two non-scheduled states (executed -> failed) renders identically,
-- so it stays quiet. This is the same rule as the game emitters - announce
-- exactly what the projection would render differently, and nothing else.

BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.fn_emit_managed_schedule_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_kind text := COALESCE(NEW.game_kind, OLD.game_kind);
  v_game uuid := COALESCE(NEW.game_id,   OLD.game_id);
  v_was  boolean := (TG_OP <> 'INSERT' AND OLD.status = 'scheduled');
  v_is   boolean := (TG_OP <> 'DELETE' AND NEW.status = 'scheduled');
  v_club uuid;
BEGIN
  -- Nothing the board renders moved.
  IF NOT v_was AND NOT v_is THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND v_was AND v_is
     AND NEW.execute_at IS NOT DISTINCT FROM OLD.execute_at THEN
    RETURN NULL;
  END IF;

  IF v_kind = 'table' THEN
    SELECT t.club_id INTO v_club FROM public.tables t WHERE t.id = v_game;
  ELSE
    SELECT t.club_id INTO v_club FROM public.tournaments t WHERE t.id = v_game;
  END IF;

  -- The game is gone; its own DELETE already told the board.
  IF v_club IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM public.fn_emit_game_management_event(
    'game_changed', v_club, NULL, NULL, v_kind, v_game, NULL,
    jsonb_build_object('operation', lower(TG_OP), 'source', 'schedule'));
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_managed_game_schedules_emit ON public.managed_game_schedules;
CREATE TRIGGER trg_managed_game_schedules_emit
AFTER INSERT OR UPDATE OR DELETE ON public.managed_game_schedules
FOR EACH ROW EXECUTE FUNCTION public.fn_emit_managed_schedule_event();

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal
      AND c.relname = 'managed_game_schedules'
      AND p.proname = 'fn_emit_managed_schedule_event'
  ) THEN
    RAISE EXCEPTION 'the pending-close emitter is not attached to managed_game_schedules';
  END IF;

  -- This emitter must NOT be counted among the two game-row emitters, whose
  -- own migration asserts there are exactly two.
  IF (SELECT count(*) FROM pg_trigger t
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal
        AND p.proname = 'fn_emit_managed_game_row_event') <> 2 THEN
    RAISE EXCEPTION 'the tables/tournaments emitter count changed';
  END IF;
END;
$assert$;

COMMIT;
