-- 20261020171735_lightning_settlement_evaluates_the_original_cash_stay_clock.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Lightning commits the normal physical stack delta but never evaluates the
-- original cash session afterwards. A player can win for hours while their
-- clock remains unopened. Evaluate that SAME clock in the original settlement
-- transaction, after the physical stack write. No new payer, timer, baseline,
-- retrospective credit, session identity or money movement is introduced.
-- Conversion and reversion do not fire this trigger.

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';

DO $pre$
BEGIN
  IF to_regprocedure('public.fn_lightning_cash_clock_at_settlement()') IS NOT NULL THEN
    RAISE EXCEPTION 'lightning_cash_clock_already_installed' USING ERRCODE = '55000';
  END IF;
  IF md5(pg_get_functiondef('public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure))
       IS DISTINCT FROM '0670ed75762f05e7ad3346a1c95e84dc'
     OR md5(pg_get_functiondef('public.fn_cash_session_evaluate(uuid,jsonb)'::regprocedure))
       IS DISTINCT FROM '63c48e5d33b963562295d32e6fbee380' THEN
    RAISE EXCEPTION 'lightning_cash_clock_owner_preimage_changed' USING ERRCODE = '55000';
  END IF;
END $pre$;

CREATE FUNCTION public.fn_lightning_cash_clock_at_settlement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $function$
DECLARE boundary record; expected integer; evaluated integer := 0;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'lightning_cash_clock_requires_engine' USING ERRCODE = '42501';
  END IF;
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN' USING ERRCODE = '55006';
  END IF;
  SELECT count(*) INTO expected
  FROM public.lightning_hand_player hp
  JOIN public.lightning_pool_slot sl ON sl.id = hp.pool_slot_id
  JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
  WHERE hp.hand_id = NEW.hand_id AND ps.exited_at IS NULL;
  -- The ordinary engine evaluates final stacks before departures. Lightning
  -- can anchor one hand at several physical tables, so retain each original
  -- table/session/seat identity and group only those exact participants.
  FOR boundary IN
    SELECT ts.table_id,
      jsonb_agg(jsonb_build_object('user_id', hp.player_id,
        'active', (
          (ps.state = 'active' AND NOT coalesce(ts.is_sitting_out, false)
                               AND NOT coalesce(ts.leave_pending, false))
          -- The ordinary engine serves a voluntary leave held by its clock:
          -- the engine's compulsory sit-out must not stop that countdown.
          OR (coalesce(ts.leave_pending, false) AND EXISTS (SELECT 1 FROM public.seat_departure_requests d
                     WHERE d.occupancy_id = ts.occupancy_id
                       AND d.user_id = ts.user_id AND d.table_id = ts.table_id
                       AND d.seat_number = ts.seat_number AND d.leave_mode = 'voluntary'))
        )) ORDER BY hp.player_id) AS entries
    FROM public.lightning_hand_player hp
    JOIN public.lightning_pool_slot sl ON sl.id = hp.pool_slot_id AND sl.player_id = hp.player_id
      AND sl.cluster_id = NEW.cluster_id AND sl.cluster_epoch = NEW.cluster_epoch
    JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
      AND ps.player_id = hp.player_id AND ps.cluster_id = NEW.cluster_id
      AND ps.cluster_epoch = NEW.cluster_epoch
    JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id AND ts.user_id = hp.player_id
      AND ts.left_at IS NULL
    JOIN public.cash_player_session cs ON cs.id = ps.cash_player_session_id
      AND cs.player_id = hp.player_id AND cs.table_id = ts.table_id
      AND cs.scope_type = 'table' AND cs.scope_id = ts.table_id
      AND cs.cluster_id = NEW.cluster_id AND cs.closed_at IS NULL
    WHERE hp.hand_id = NEW.hand_id AND ps.exited_at IS NULL
    GROUP BY ts.table_id ORDER BY ts.table_id
  LOOP
    -- Omit stack: early folders may already have another hand; only the
    -- original physical seat's current authoritative stack may be evaluated.
    PERFORM public.fn_cash_session_evaluate(boundary.table_id, boundary.entries);
    evaluated := evaluated + jsonb_array_length(boundary.entries);
  END LOOP;
  IF evaluated IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'lightning_cash_clock_anchor_unavailable' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION public.fn_lightning_cash_clock_at_settlement()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER lightning_cash_clock_at_settlement
AFTER UPDATE OF settled_at ON public.lightning_hand
FOR EACH ROW WHEN (OLD.settled_at IS NULL AND NEW.settled_at IS NOT NULL)
EXECUTE FUNCTION public.fn_lightning_cash_clock_at_settlement();

-- @live-proof: EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.lightning_hand'::regclass AND tgname='lightning_cash_clock_at_settlement' AND tgfoid='public.fn_lightning_cash_clock_at_settlement()'::regprocedure AND tgenabled='O' AND NOT tgdeferrable)
-- @live-proof: md5(pg_get_functiondef('public.fn_lightning_cash_clock_at_settlement()'::regprocedure))='9e84b5c6f32b44ed7d8ccc546381f738'
-- @live-proof: NOT has_function_privilege('anon','public.fn_lightning_cash_clock_at_settlement()','EXECUTE') AND NOT has_function_privilege('authenticated','public.fn_lightning_cash_clock_at_settlement()','EXECUTE') AND NOT has_function_privilege('service_role','public.fn_lightning_cash_clock_at_settlement()','EXECUTE')

COMMIT;
