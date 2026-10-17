-- 20261017144031_cash_game_owner_switch_off.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- THE OWNER'S SWITCH FOR A RUNNING CASH GAME (2026-10-17).
-- `cash_games.enabled = false` is OPORD 1.4 18.4: no seeding, no opening;
-- empties close. The fleet already refuses to seat a disabled game
-- (HorseDisabledGames), fn_cash_game_join refuses it, and fn_cash_cluster_tick
-- closes each of its tables only once nobody is seated. Every player already
-- seated keeps playing and leaves through the ordinary cash-out.
--
-- But no authenticated door could set it. fn_close_managed_game flips it only
-- by closing the MAIN table, and that refuses while anyone is seated - so a
-- game that is never empty, because players keep arriving, could never be
-- switched off by its owner. Measured on the private Lightning pilot: the
-- replaced nine-seat Madness held 5 to 9 seated all day and its replacement
-- could not be created (it needs the same one-per-key and one-per-band slot).
--
-- This door does only the switch. It never stands anyone up, moves a seat,
-- touches a stack, closes a table or writes money; the existing controller
-- closes the tables as they empty. It refuses a game in any Lightning state
-- (that drains through fn_lightning_operator_control first), it is the club's
-- game-creating authority only, it needs a live session, and one request id
-- answers the same way however often it is sent.
-- @live-proof: (SELECT has_function_privilege('authenticated','public.fn_cash_game_switch_off(uuid,uuid,text)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_cash_game_switch_off(uuid,uuid,text)','EXECUTE'))

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

CREATE OR REPLACE FUNCTION public.fn_cash_game_switch_off(
  p_game_id uuid,
  p_request_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  g record;
  v_prior record;
  v_seated integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF p_game_id IS NULL OR p_request_id IS NULL OR length(v_reason) < 12 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
  END IF;
  IF NOT public.fn_can_create_games(g.club_id, v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  -- The same request answers the same way; a reused id with another actor or
  -- reason is refused rather than read as permission. Read through the
  -- (game_id, at) index: the event log is large and request_id is unindexed.
  SELECT * INTO v_prior FROM public.cash_cluster_events e
   WHERE e.game_id = p_game_id AND e.kind = 'game_switched_off_by_owner'
     AND e.request_id = p_request_id
   LIMIT 1;
  IF FOUND THEN
    IF v_prior.payload ->> 'actor_id' IS DISTINCT FROM v_uid::text
       OR v_prior.payload ->> 'reason' IS DISTINCT FROM v_reason THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'idempotency_conflict');
    END IF;
    RETURN jsonb_build_object('ok', true, 'game_id', p_game_id, 'enabled', g.enabled,
                              'replayed', true, 'event_id', v_prior.id);
  END IF;

  IF NOT g.enabled THEN
    RETURN jsonb_build_object('ok', true, 'game_id', p_game_id, 'enabled', false,
                              'already', true);
  END IF;
  IF coalesce(g.lightning_enabled, false) OR g.cluster_mode IS DISTINCT FROM 'must_move' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lightning_state_requires_operator_drain',
                              'cluster_mode', g.cluster_mode,
                              'lightning_enabled', g.lightning_enabled);
  END IF;

  SELECT count(*)::integer INTO v_seated
    FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
   WHERE t.cluster_id = g.id AND ts.left_at IS NULL;

  UPDATE public.cash_games SET enabled = false, updated_at = now() WHERE id = g.id;
  INSERT INTO public.cash_cluster_events (game_id, kind, request_id, cluster_epoch, payload)
  VALUES (g.id, 'game_switched_off_by_owner', p_request_id, g.cluster_epoch,
          jsonb_build_object('actor_id', v_uid::text, 'reason', v_reason,
                             'seated_at_switch_off', v_seated))
  RETURNING id INTO v_prior;

  RETURN jsonb_build_object('ok', true, 'game_id', g.id, 'enabled', false,
                            'replayed', false, 'event_id', v_prior.id,
                            'seated_at_switch_off', v_seated);
END;
$fn$;

COMMENT ON FUNCTION public.fn_cash_game_switch_off(uuid, uuid, text) IS
  'The club owner''s switch for a running cash game (OPORD 18.4: no seeding, no opening; empties close). Sets enabled = false only: never stands anyone up, moves a seat, touches a stack, closes a table or writes money; fn_cash_cluster_tick closes each table once it is empty. Refuses any Lightning state. Idempotent on p_request_id.';

REVOKE ALL ON FUNCTION public.fn_cash_game_switch_off(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_switch_off(uuid, uuid, text) TO authenticated, service_role;

COMMIT;
