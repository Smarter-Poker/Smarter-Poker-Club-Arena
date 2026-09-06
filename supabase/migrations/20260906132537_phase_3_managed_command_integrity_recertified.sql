-- 20260906132537_phase_3_managed_command_integrity_recertified.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The original command gateway serialized on the target game row. That makes
-- two commands for one game safe, but it does not serialize one command UUID
-- reused concurrently across two different games. Both requests could miss
-- the receipt, lock different rows, and race at the receipt primary key. The
-- loser then leaked a raw unique-violation instead of returning the promised
-- idempotency_conflict. Serialize the command identity before inspecting its
-- receipt, then keep the existing game-row lock for per-game ordering.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_execute_managed_game_command(
  p_command_id uuid,
  p_kind text,
  p_game_id uuid,
  p_action text,
  p_expected_version integer,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_club uuid;
  v_request_hash text;
  v_existing public.managed_game_command_receipts%ROWTYPE;
  v_before integer;
  v_after integer;
  v_action_result jsonb;
  v_result jsonb;
  v_status text;
  v_reason text;
  v_message text;
  v_sqlstate text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_command_id IS NULL
     OR p_game_id IS NULL
     OR p_kind NOT IN ('table', 'tournament')
     OR p_action NOT IN ('update', 'close')
     OR p_expected_version IS NULL
     OR p_expected_version < 1
     OR jsonb_typeof(COALESCE(p_payload, '{}'::jsonb)) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  v_request_hash := public.fn_managed_game_command_hash(
    p_command_id, p_kind, p_game_id, p_action, p_expected_version, p_payload
  );

  -- A command UUID is a global identity, not a per-game identity. Take this
  -- lock before the first receipt read so cross-game UUID reuse has the same
  -- deterministic replay/conflict behavior as a duplicate on one game.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('managed-game-command:' || p_command_id::text, 0)
  );

  SELECT * INTO v_existing
    FROM public.managed_game_command_receipts
   WHERE command_id = p_command_id;
  IF FOUND THEN
    IF v_existing.actor_id <> v_uid OR v_existing.request_hash <> v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'idempotency_conflict');
    END IF;
    RETURN v_existing.result || jsonb_build_object('replayed', true);
  END IF;

  -- A separate row lock orders every distinct command for the same game.
  IF p_kind = 'table' THEN
    SELECT club_id INTO v_club
      FROM public.tables
     WHERE id = p_game_id
     FOR UPDATE;
  ELSE
    SELECT club_id INTO v_club
      FROM public.tournaments
     WHERE id = p_game_id
     FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
  END IF;
  IF NOT public.fn_can_create_games(v_club, v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  SELECT version INTO v_before
    FROM public.managed_game_contract_versions
   WHERE game_kind = p_kind AND game_id = p_game_id
   ORDER BY version DESC
   LIMIT 1;

  IF v_before IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'contract_not_found');
  END IF;

  INSERT INTO public.managed_game_command_receipts (
    command_id, actor_id, game_kind, game_id, command_action,
    expected_version, request_hash, status, contract_version_before
  ) VALUES (
    p_command_id, v_uid, p_kind, p_game_id, p_action,
    p_expected_version, v_request_hash, 'processing', v_before
  );

  IF p_expected_version <> v_before THEN
    v_result := jsonb_build_object(
      'ok', false,
      'reason', 'stale_contract_version',
      'command_id', p_command_id,
      'command_status', 'rejected',
      'expected_version', p_expected_version,
      'current_version', v_before,
      'version_before', v_before,
      'version_after', v_before,
      'replayed', false
    );
    UPDATE public.managed_game_command_receipts
       SET status = 'rejected', result = v_result,
           contract_version_after = v_before, completed_at = now()
     WHERE command_id = p_command_id;
    RETURN v_result;
  END IF;

  BEGIN
    IF p_action = 'update' THEN
      v_action_result := public.fn_update_managed_game(p_kind, p_game_id, p_payload);
    ELSE
      v_action_result := public.fn_close_managed_game(p_kind, p_game_id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    v_reason := CASE
      WHEN v_sqlstate IN ('22P02', '22003', '23514') THEN 'invalid_payload'
      WHEN v_sqlstate = '42501' THEN 'not_authorized'
      WHEN v_sqlstate = '55000' THEN 'contract_rule_blocked'
      ELSE 'command_failed'
    END;
    v_action_result := jsonb_build_object(
      'ok', false,
      'reason', v_reason,
      'message', CASE
        WHEN v_sqlstate = '55000' THEN v_message
        ELSE NULL
      END
    );
  END;

  SELECT version INTO v_after
    FROM public.managed_game_contract_versions
   WHERE game_kind = p_kind AND game_id = p_game_id
   ORDER BY version DESC
   LIMIT 1;
  v_after := COALESCE(v_after, v_before);
  v_status := CASE WHEN COALESCE((v_action_result ->> 'ok')::boolean, false)
    THEN 'succeeded' ELSE 'rejected' END;

  v_result := COALESCE(v_action_result, jsonb_build_object(
    'ok', false, 'reason', 'command_failed'
  )) || jsonb_build_object(
    'command_id', p_command_id,
    'command_status', v_status,
    'expected_version', p_expected_version,
    'current_version', v_after,
    'version_before', v_before,
    'version_after', v_after,
    'replayed', false
  );

  UPDATE public.managed_game_command_receipts
     SET status = v_status, result = v_result,
         contract_version_after = v_after, completed_at = now()
   WHERE command_id = p_command_id;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_execute_managed_game_command(
  uuid, text, uuid, text, integer, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_execute_managed_game_command(
  uuid, text, uuid, text, integer, jsonb
) TO authenticated, service_role;

-- The implementation functions remain private. Reasserting this in the same
-- migration makes a replayed or rebuilt database preserve the one-door law.
REVOKE ALL ON FUNCTION public.fn_update_managed_game(text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_close_managed_game(text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_update_managed_game(text, uuid, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_close_managed_game(text, uuid)
  TO service_role;

DO $assert$
DECLARE
  v_source text;
BEGIN
  SELECT p.prosrc INTO v_source
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.oid = 'public.fn_execute_managed_game_command(uuid,text,uuid,text,integer,jsonb)'::regprocedure;

  IF position('pg_advisory_xact_lock' in v_source) = 0
     OR position('pg_advisory_xact_lock' in v_source) > position('SELECT * INTO v_existing' in v_source) THEN
    RAISE EXCEPTION 'ASSERT FAILED: command UUID is not locked before receipt lookup';
  END IF;
  IF NOT has_function_privilege(
       'authenticated',
       'public.fn_execute_managed_game_command(uuid,text,uuid,text,integer,jsonb)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'ASSERT FAILED: authenticated command gateway is unavailable';
  END IF;
  IF has_function_privilege(
       'authenticated', 'public.fn_update_managed_game(text,uuid,jsonb)', 'EXECUTE'
     ) OR has_function_privilege(
       'authenticated', 'public.fn_close_managed_game(text,uuid)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'ASSERT FAILED: a legacy mutation helper is browser-executable';
  END IF;
END;
$assert$;

COMMIT;
