-- 20261025022742_the_owner_switch_off_answers_its_request_id_from_its_own_key.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- THE OWNER SWITCH-OFF ANSWERS ITS REQUEST ID FROM ITS OWN KEY (2026-10-25).
-- fn_cash_game_switch_off (20261017144031) found a replayed request by
-- reading cash_cluster_events for (game_id, kind, request_id). That table
-- holds about 5 million rows (4 GB) and indexes only (game_id, at), so the
-- read is a bitmap scan of EVERY event the game ever logged, under the game's
-- FOR UPDATE row lock. Measured 2026-10-25 on the Lightning pilot game
-- 56d5d6f0: 1.3 million events, the planner's estimate 1,318,360 rows, the
-- switch-off still reading after 67 s; Apply Merged Migration run 40147104607
-- (20261024213143) was refused with 57014 statement timeout after 8.1 s and
-- nothing committed. A busy game could never be switched off by its owner.
--
-- THE FIX AT THE LINE THAT CAUSED IT. The door now records each request in
-- cash_game_switch_off_requests, keyed by request_id, in the same transaction
-- as its switch and its audit event, and answers a replay by that key. Same
-- answers as before: the same request replays, another game, actor or reason
-- on the same id is idempotency_conflict, a disabled game is already. The
-- audit event is still written exactly as before. Nothing else changes: no
-- seat, stack, table or money is touched by the door.
--
-- EARLIER REQUESTS. A request id issued before this file is not in the new
-- table. Replayed against a game that is still off it answers already (no
-- action), as an unknown id always has; a game owners switched off and then
-- turned back on is the only case in which an old id could act again, and the
-- client issues a fresh id per press. Seeding them would need the same full
-- read of the event log that this file exists to remove.
--
-- The table is service-only (RLS on, no policy, no grant to anon or
-- authenticated); the SECURITY DEFINER door is its only writer. It references
-- no hot table (CLAUDE.md section 2 rule 7). One transaction; a new table and
-- one function replaced, no lock on a live table.
-- @live-proof: (SELECT to_regclass('public.cash_game_switch_off_requests') IS NOT NULL) AND (SELECT pg_get_functiondef('public.fn_cash_game_switch_off(uuid,uuid,text)'::regprocedure) ~ 'FROM public\.cash_game_switch_off_requests r' AND pg_get_functiondef('public.fn_cash_game_switch_off(uuid,uuid,text)'::regprocedure) !~ 'cash_cluster_events e') AND has_function_privilege('authenticated','public.fn_cash_game_switch_off(uuid,uuid,text)','EXECUTE') AND NOT has_function_privilege('anon','public.fn_cash_game_switch_off(uuid,uuid,text)','EXECUTE')

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.fn_cash_game_switch_off(uuid,uuid,text)'::regprocedure))
     <> '805ef1821e0aa2e2f580a35cb290283a' THEN
    RAISE EXCEPTION 'fn_cash_game_switch_off is not the 20261017144031 body this file replaces; refusing';
  END IF;
END
$guard$;

CREATE TABLE public.cash_game_switch_off_requests (
  request_id uuid PRIMARY KEY,
  game_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  reason text NOT NULL,
  event_id bigint NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cash_game_switch_off_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cash_game_switch_off_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.cash_game_switch_off_requests TO service_role;
COMMENT ON TABLE public.cash_game_switch_off_requests IS
  'One row per owner switch-off request (fn_cash_game_switch_off), keyed by its request id so a replay is answered by key instead of by reading the cash_cluster_events log. Written only by that SECURITY DEFINER door, in the same transaction as the switch and its audit event.';

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
  -- reason is refused rather than read as permission. Read by its primary key
  -- (2026-10-25): the event log has no request_id index, and on a game with
  -- 1.3 million events the old (game_id, at) bitmap scan ran past every
  -- statement budget while holding this game's row lock.
  SELECT r.event_id AS id, r.actor_id, r.reason, r.game_id INTO v_prior
    FROM public.cash_game_switch_off_requests r
   WHERE r.request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.game_id IS DISTINCT FROM p_game_id
       OR v_prior.actor_id IS DISTINCT FROM v_uid
       OR v_prior.reason IS DISTINCT FROM v_reason THEN
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
  INSERT INTO public.cash_game_switch_off_requests (request_id, game_id, actor_id, reason, event_id)
  VALUES (p_request_id, g.id, v_uid, v_reason, v_prior.id);

  RETURN jsonb_build_object('ok', true, 'game_id', g.id, 'enabled', false,
                            'replayed', false, 'event_id', v_prior.id,
                            'seated_at_switch_off', v_seated);
END;
$fn$;

COMMENT ON FUNCTION public.fn_cash_game_switch_off(uuid, uuid, text) IS
  'The club owner''s switch for a running cash game (OPORD 18.4: no seeding, no opening; empties close). Sets enabled = false only: never stands anyone up, moves a seat, touches a stack, closes a table or writes money; fn_cash_cluster_tick closes each table once it is empty. Refuses any Lightning state. Idempotent on p_request_id through cash_game_switch_off_requests.';

REVOKE ALL ON FUNCTION public.fn_cash_game_switch_off(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_switch_off(uuid, uuid, text) TO authenticated, service_role;

COMMIT;
