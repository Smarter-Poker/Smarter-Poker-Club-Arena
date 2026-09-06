-- 20260906145129_daily_mission_reroll_replay_proof_and_current_projection.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A durable financial receipt must acknowledge settlement without repainting
-- the balance or assignment captured when that receipt was first written. A
-- later wallet action or reroll may already be newer when a lost response is
-- retried from another tab.
--
-- The four-argument compatibility protocol has no request UUID. Its former
-- row-change heuristic accepted any invented stale challenge ID as a successful
-- replay. Require a matching action receipt or the exact pre-receipt Diamond
-- journal reference before that compatibility path may report success.

BEGIN;

ALTER FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer, uuid)
  RENAME TO reroll_daily_challenge_one_diamond_receipted_body;

REVOKE ALL ON FUNCTION public.reroll_daily_challenge_one_diamond_receipted_body(
  uuid,
  uuid,
  text,
  integer,
  uuid
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.reroll_daily_challenge(
  p_user_id uuid,
  p_challenge_row_id uuid,
  p_expected_challenge_id text,
  p_cost integer,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authenticated');
  END IF;
  IF p_user_id IS NULL OR p_user_id <> v_uid THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'cannot reroll another player''s challenge'
    );
  END IF;

  v_result := public.reroll_daily_challenge_one_diamond_receipted_body(
    p_user_id,
    p_challenge_row_id,
    p_expected_challenge_id,
    p_cost,
    p_request_id
  );

  IF COALESCE((v_result ->> 'success')::boolean, false)
     AND COALESCE((v_result ->> 'alreadyRerolled')::boolean, false)
  THEN
    RETURN jsonb_build_object(
      'success', true,
      'requestId', p_request_id,
      'alreadyRerolled', true,
      'diamondsSpent', 0,
      'refreshRequired', true
    );
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer, uuid)
  TO authenticated, service_role;

ALTER FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer)
  RENAME TO reroll_daily_challenge_compatibility_unverified_body;

REVOKE ALL ON FUNCTION public.reroll_daily_challenge_compatibility_unverified_body(
  uuid,
  uuid,
  text,
  integer
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.reroll_daily_challenge(
  p_user_id uuid,
  p_challenge_row_id uuid,
  p_expected_challenge_id text,
  p_cost integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_current_challenge_id text;
  v_has_replay_proof boolean := false;
BEGIN
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authenticated');
  END IF;
  IF p_user_id IS NULL OR p_user_id <> v_uid THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'cannot reroll another player''s challenge'
    );
  END IF;
  IF p_cost IS NULL OR p_cost NOT IN (1, 10) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'reroll price changed; refresh and try again'
    );
  END IF;

  PERFORM public.fn_lock_daily_mission_user(v_uid);

  SELECT challenge_id INTO v_current_challenge_id
  FROM public.user_daily_challenges
  WHERE id = p_challenge_row_id
    AND user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'challenge not found');
  END IF;

  -- Proof is checked even when the row currently carries the expected ID.
  -- Catalog assignments can cycle A -> B -> A; equality alone cannot prove a
  -- UUID-less compatibility request is new after a settled earlier A reroll.
  SELECT
    EXISTS (
      SELECT 1
      FROM public.daily_challenge_reroll_receipts receipt
      WHERE receipt.user_id = v_uid
        AND receipt.challenge_row_id = p_challenge_row_id
        AND receipt.expected_challenge_id = p_expected_challenge_id
        AND receipt.cost = p_cost
    )
    OR EXISTS (
      SELECT 1
      FROM public.diamond_transactions journal
      WHERE journal.user_id = v_uid
        AND journal.reference_id =
          'challenge_reroll:' || p_challenge_row_id::text || ':' || p_expected_challenge_id
        AND journal.amount = -p_cost
        AND journal.transaction_type = 'daily_challenge_reroll'
        AND journal.type = 'daily_challenge_reroll'
        AND journal.metadata ->> 'challenge_row_id' = p_challenge_row_id::text
        AND journal.metadata ->> 'from_challenge_id' = p_expected_challenge_id
    )
  INTO v_has_replay_proof;

  IF v_has_replay_proof THEN
    -- Force the already-settled branch in the private compatibility body. It
    -- returns the current row and balance without creating a UUID or debit.
    RETURN public.reroll_daily_challenge_compatibility_unverified_body(
      p_user_id,
      p_challenge_row_id,
      NULL::text,
      p_cost
    );
  END IF;

  IF v_current_challenge_id IS DISTINCT FROM p_expected_challenge_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'challenge changed; refresh and try again'
    );
  END IF;

  RETURN public.reroll_daily_challenge_compatibility_unverified_body(
    p_user_id,
    p_challenge_row_id,
    p_expected_challenge_id,
    p_cost
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer, uuid) IS
'One-Diamond Daily Mission reroll gateway. Replays acknowledge the durable receipt without returning a stale assignment or wallet projection.';

COMMENT ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer) IS
'Compatibility Daily Mission reroll gateway. A settled request replays only when an exact receipt or historical Diamond journal proves settlement, including after an assignment ID cycles.';

COMMENT ON FUNCTION public.reroll_daily_challenge_one_diamond_receipted_body(
  uuid,
  uuid,
  text,
  integer,
  uuid
) IS
'Private receipt-bearing Daily Mission reroll implementation. Callable only through the projection-safe public gateway.';

COMMENT ON FUNCTION public.reroll_daily_challenge_compatibility_unverified_body(
  uuid,
  uuid,
  text,
  integer
) IS
'Private compatibility implementation. Callable only after the public gateway verifies replay evidence.';

DO $verify$
DECLARE
  v_five_arg_source text;
  v_four_arg_source text;
  v_four_arg_default text;
BEGIN
  SELECT pg_get_functiondef(
    'public.reroll_daily_challenge(uuid,uuid,text,integer,uuid)'::regprocedure
  ) INTO v_five_arg_source;

  SELECT pg_get_functiondef(
    'public.reroll_daily_challenge(uuid,uuid,text,integer)'::regprocedure
  ) INTO v_four_arg_source;

  SELECT pg_get_expr(p.proargdefaults, 0)
  INTO v_four_arg_default
  FROM pg_proc p
  WHERE p.oid = 'public.reroll_daily_challenge(uuid,uuid,text,integer)'::regprocedure;

  IF v_five_arg_source NOT ILIKE '%''refreshRequired'', true%'
     OR v_five_arg_source ILIKE '%v_result -> ''challenge''%'
     OR v_five_arg_source ILIKE '%v_result -> ''diamondBalance''%'
  THEN
    RAISE EXCEPTION 'Five-argument reroll replay can expose a stale projection';
  END IF;

  IF v_four_arg_default IS DISTINCT FROM '1'
     OR v_four_arg_source NOT ILIKE '%p_cost IS NULL OR p_cost NOT IN (1, 10)%'
     OR v_four_arg_source NOT ILIKE '%daily_challenge_reroll_receipts%'
     OR v_four_arg_source NOT ILIKE '%receipt.cost = p_cost%'
     OR v_four_arg_source NOT ILIKE '%challenge_reroll:%p_challenge_row_id%p_expected_challenge_id%'
     OR v_four_arg_source NOT ILIKE '%journal.amount = -p_cost%'
     OR v_four_arg_source NOT ILIKE '%journal.transaction_type = ''daily_challenge_reroll''%'
     OR v_four_arg_source NOT ILIKE '%journal.type = ''daily_challenge_reroll''%'
     OR v_four_arg_source NOT ILIKE '%journal.metadata ->> ''challenge_row_id'' = p_challenge_row_id::text%'
     OR v_four_arg_source NOT ILIKE '%journal.metadata ->> ''from_challenge_id'' = p_expected_challenge_id%'
     OR v_four_arg_source NOT ILIKE '%IF v_has_replay_proof THEN%'
     OR v_four_arg_source NOT ILIKE '%NULL::text%'
  THEN
    RAISE EXCEPTION 'Four-argument reroll replay proof is incomplete';
  END IF;

  IF has_function_privilege(
       'authenticated',
       'public.reroll_daily_challenge_one_diamond_receipted_body(uuid,uuid,text,integer,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.reroll_daily_challenge_compatibility_unverified_body(uuid,uuid,text,integer)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.reroll_daily_challenge(uuid,uuid,text,integer,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.reroll_daily_challenge(uuid,uuid,text,integer)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.reroll_daily_challenge(uuid,uuid,text,integer,uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.reroll_daily_challenge(uuid,uuid,text,integer)',
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION 'Daily Mission reroll gateway grants are unsafe';
  END IF;
END;
$verify$;

COMMIT;
