-- 20260909192240_managed_close_preserves_cash_occupancy_and_atomic_tournament_cancellation
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-09 19:22:40 UTC.
--
-- A later cash-occupancy migration correctly hardened the table half of
-- fn_close_managed_game, but copied the pre-cancellation tournament half back
-- over the atomic cancellation authority. An empty tournament could therefore
-- be marked CANCELLED and have its tables closed without committing the
-- immutable cancellation receipt required by every terminal path.
--
-- This definition composes both current contracts in the one live owner:
--   * cash-table closes retain the native occupancy-parent lock ordering,
--     stale-cluster refusal, active-seat refusal, and main-game shutdown;
--   * tournament closes retain the global terminal-settlement lock and route
--     through atomic_cancel_tournament, accepting only its exact stored receipt.
--
-- No repair, replay sweep, watcher, reconciler, refund, historical mutation,
-- or alternate close door is introduced. The preflight refuses any live
-- definition other than the exact later cash-occupancy baseline or this exact
-- composition, so an unreviewed concurrent owner cannot be overwritten.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL transaction_timeout = '180s';

SELECT pg_advisory_xact_lock(
  hashtextextended('ca:tournament-terminal-settlement:v1', 0));

DO $preflight$
DECLARE
  v_definition text;
BEGIN
  IF to_regprocedure('public.fn_close_managed_game(text,uuid)') IS NULL
     OR to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_can_create_games(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'managed close composition prerequisites are absent';
  END IF;

  SELECT pg_get_functiondef(
           'public.fn_close_managed_game(text,uuid)'::regprocedure)
    INTO v_definition;

  IF md5(v_definition) NOT IN (
    '96be8943f1b86538d2b825c894d21f7a',
    '0ad2e40801bb235892305071e9bc78cb'
  ) THEN
    RAISE EXCEPTION 'unreviewed managed close definition';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.fn_close_managed_game(
  p_kind text,
  p_game_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $managed_close$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
  v_status text;
  v_cluster uuid;
  v_role text;
  v_initial_cluster uuid;
  v_cancel jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_kind = 'table' THEN
    -- Match the cluster controller's game-to-table order. Authorize the
    -- initial scope before locking, then recheck the locked table below.
    SELECT club_id, cluster_id
      INTO v_club, v_initial_cluster
      FROM public.tables
     WHERE id = p_game_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
    END IF;
    IF NOT public.fn_can_create_games(v_club, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
    IF v_initial_cluster IS NOT NULL THEN
      PERFORM 1
        FROM public.cash_games
       WHERE id = v_initial_cluster
       FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
      END IF;
    END IF;

    SELECT club_id, status, cluster_id, role
      INTO v_club, v_status, v_cluster, v_role
      FROM public.tables
     WHERE id = p_game_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
    END IF;
    IF v_cluster IS DISTINCT FROM v_initial_cluster THEN
      RAISE EXCEPTION 'STALE_GAME_CONTEXT: table changed games while closing'
        USING ERRCODE = '55000';
    END IF;
    IF NOT public.fn_can_create_games(v_club, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
    IF lower(COALESCE(v_status, '')) IN (
      'closed', 'completed', 'cancelled', 'finished'
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_closed');
    END IF;

    -- The native admission FK serializes new seats against this parent lock.
    -- A refusal needs a snapshot, not a seat lock ahead of an engine cashout.
    PERFORM 1
      FROM public.table_seats ts
     WHERE ts.table_id = p_game_id
       AND ts.left_at IS NULL
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'players_seated');
    END IF;

    UPDATE public.tables
       SET status = 'closed', current_players = 0, updated_at = now()
     WHERE id = p_game_id;

    IF v_cluster IS NOT NULL AND v_role = 'main' THEN
      UPDATE public.cash_games
         SET enabled = false,
             state = 'dormant',
             closed_at = now(),
             closed_by = v_uid,
             updated_at = now()
       WHERE id = v_cluster
         AND enabled;
    END IF;
    RETURN jsonb_build_object('ok', true);
  ELSIF p_kind = 'tournament' THEN
    -- Every terminal owner takes this lock before the first tournament row.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('ca:tournament-terminal-settlement:v1', 0));

    SELECT club_id, status
      INTO v_club, v_status
      FROM public.tournaments
     WHERE id = p_game_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
    END IF;
    IF NOT public.fn_can_create_games(v_club, v_uid) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
    END IF;
    IF upper(COALESCE(v_status, '')) IN (
      'COMPLETED', 'CANCELLED', 'CANCELED', 'COMPLETING'
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_closed');
    END IF;

    PERFORM 1
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_game_id
     FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'players_registered');
    END IF;

    PERFORM set_config('app.managed_game_lifecycle', 'on', true);
    v_cancel := public.atomic_cancel_tournament(p_game_id, v_uid);
    PERFORM set_config('app.managed_game_lifecycle', '', true);
    IF v_cancel->>'ok' IS DISTINCT FROM 'true'
       OR v_cancel->>'fully_settled' IS DISTINCT FROM 'true'
       OR v_cancel->>'status' IS DISTINCT FROM 'CANCELLED'
       OR v_cancel->>'tournament_id' IS DISTINCT FROM p_game_id::text
       OR (v_cancel->>'source_player_count')::integer IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION
        'managed tournament close did not return its exact atomic cancellation receipt'
        USING ERRCODE = 'P0404';
    END IF;
    RETURN jsonb_build_object('ok', true);
  END IF;

  RETURN jsonb_build_object('ok', false, 'reason', 'invalid_game_kind');
END;
$managed_close$;

REVOKE ALL ON FUNCTION public.fn_close_managed_game(text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_close_managed_game(text, uuid)
  TO service_role;

DO $verify$
DECLARE
  v_definition text;
  v_tournament_branch text;
BEGIN
  SELECT pg_get_functiondef(
           'public.fn_close_managed_game(text,uuid)'::regprocedure)
    INTO v_definition;
  v_tournament_branch := substring(
    v_definition FROM position('ELSIF p_kind = ''tournament'' THEN' IN v_definition)
  );

  IF md5(v_definition) <> '0ad2e40801bb235892305071e9bc78cb'
     OR position('STALE_GAME_CONTEXT: table changed games while closing' IN v_definition) = 0
     OR position(
          'v_cancel := public.atomic_cancel_tournament(p_game_id, v_uid)'
          IN v_tournament_branch
        ) = 0
     OR position(
          'managed tournament close did not return its exact atomic cancellation receipt'
          IN v_tournament_branch
        ) = 0
     OR position('UPDATE public.tournaments' IN v_tournament_branch) > 0
     OR has_function_privilege(
          'anon', 'public.fn_close_managed_game(text,uuid)', 'EXECUTE'
        )
     OR has_function_privilege(
          'authenticated', 'public.fn_close_managed_game(text,uuid)', 'EXECUTE'
        )
     OR NOT has_function_privilege(
          'service_role', 'public.fn_close_managed_game(text,uuid)', 'EXECUTE'
        ) THEN
    RAISE EXCEPTION 'managed close composition did not install exactly';
  END IF;
END;
$verify$;

COMMIT;
