-- 20260906134133_daily_mission_rerolls_cost_one_diamond.sql
--
-- A Daily Mission reroll costs one Diamond. The previous ten-Diamond price
-- was too close to the value of the replacement mission and made the control
-- economically irrational.
--
-- Historical ten-Diamond settlements remain immutable. Their request-bound
-- receipts can still replay after a lost response, but every fresh request is
-- validated against the new one-Diamond price before any wallet debit.
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch. All DDL is kept in one transaction to trigger one schema
-- cache reload.

BEGIN;

ALTER TABLE public.daily_challenge_reroll_receipts
  DROP CONSTRAINT IF EXISTS daily_challenge_reroll_receipts_cost_check;

ALTER TABLE public.daily_challenge_reroll_receipts
  ADD CONSTRAINT daily_challenge_reroll_receipts_settled_cost_check
  CHECK (cost IN (1, 10));

CREATE OR REPLACE FUNCTION public.reroll_daily_challenge(
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
  REROLL_COST constant integer := 1;
  v_uid uuid := auth.uid();
  v_row public.user_daily_challenges%ROWTYPE;
  v_receipt public.daily_challenge_reroll_receipts%ROWTYPE;
  v_replacement text;
  v_deduct jsonb;
  v_balance integer;
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
  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'a reroll request id is required');
  END IF;

  PERFORM public.fn_lock_daily_mission_user(v_uid);

  -- Receipt replay precedes the current-price guard deliberately. A request
  -- settled under the former price is financial history and must remain
  -- replayable with zero new spend after this price change.
  SELECT * INTO v_receipt
  FROM public.daily_challenge_reroll_receipts
  WHERE user_id = v_uid
    AND request_id = p_request_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_receipt.challenge_row_id IS DISTINCT FROM p_challenge_row_id
       OR v_receipt.expected_challenge_id IS DISTINCT FROM p_expected_challenge_id
       OR v_receipt.cost IS DISTINCT FROM p_cost
    THEN
      RETURN jsonb_build_object(
        'success', false,
        'requestId', p_request_id,
        'error', 'reroll request id is already bound to another request'
      );
    END IF;

    RETURN v_receipt.result || jsonb_build_object(
      'requestId', p_request_id,
      'alreadyRerolled', true,
      'diamondsSpent', 0
    );
  END IF;

  IF p_cost IS DISTINCT FROM REROLL_COST THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'reroll price changed; refresh and try again'
    );
  END IF;

  SELECT * INTO v_row
  FROM public.user_daily_challenges
  WHERE id = p_challenge_row_id
    AND user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'challenge not found');
  END IF;
  IF v_row.challenge_id IS DISTINCT FROM p_expected_challenge_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'challenge changed; refresh and try again'
    );
  END IF;
  IF v_row.completed OR v_row.claimed THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'completed challenges cannot be rerolled'
    );
  END IF;

  SELECT c.id INTO v_replacement
  FROM public.daily_challenge_catalog c
  WHERE c.tier = v_row.tier_snapshot
    AND c.is_active
    AND c.id <> v_row.challenge_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.user_daily_challenges active
      WHERE active.user_id = v_uid
        AND active.assigned_date = v_row.assigned_date
        AND active.challenge_id = c.id
    )
  ORDER BY random()
  LIMIT 1;

  IF v_replacement IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'no replacement challenge is available'
    );
  END IF;

  v_deduct := public.deduct_diamonds(
    p_user_id          := v_uid,
    p_amount           := REROLL_COST,
    p_description      := 'Daily challenge reroll',
    p_transaction_type := 'challenge_reroll',
    p_source           := 'daily_challenge_reroll',
    p_metadata         := jsonb_build_object(
                            'request_id', p_request_id,
                            'challenge_row_id', v_row.id,
                            'from_challenge_id', v_row.challenge_id,
                            'to_challenge_id', v_replacement,
                            'tier', v_row.tier_snapshot
                          ),
    p_reference_id     := 'challenge_reroll:' || p_request_id::text,
    p_cooldown_seconds := 0
  );

  IF COALESCE((v_deduct ->> 'success')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', COALESCE(v_deduct ->> 'error', 'not enough diamonds')
    );
  END IF;
  IF COALESCE((v_deduct ->> 'idempotent')::boolean, false) THEN
    RAISE EXCEPTION 'A reroll debit exists without its bound action receipt';
  END IF;

  PERFORM set_config('app.daily_challenge_reroll', '1', true);
  UPDATE public.user_daily_challenges
  SET challenge_id = v_replacement,
      progress = 0,
      completed = false,
      claimed = false,
      completed_at = NULL,
      claimed_at = NULL
  WHERE id = v_row.id
    AND user_id = v_uid
  RETURNING * INTO v_row;

  SELECT COALESCE(diamonds, 0)::integer INTO v_balance
  FROM public.profiles
  WHERE id = v_uid;

  v_result := jsonb_build_object(
    'success', true,
    'requestId', p_request_id,
    'alreadyRerolled', false,
    'challengeId', v_row.challenge_id,
    'diamondBalance', COALESCE(v_balance, 0),
    'diamondsSpent', REROLL_COST,
    'challenge', jsonb_build_object(
      'id', v_row.id,
      'challenge_id', v_row.challenge_id,
      'assigned_date', v_row.assigned_date,
      'progress', v_row.progress,
      'completed', v_row.completed,
      'claimed', v_row.claimed,
      'completed_at', v_row.completed_at,
      'name', v_row.challenge_name_snapshot,
      'description', v_row.challenge_description_snapshot,
      'challenge_type', v_row.challenge_type_snapshot,
      'requirement', v_row.requirement_snapshot,
      'chip_reward', 0,
      'diamond_reward', v_row.diamond_reward_snapshot,
      'tier', v_row.tier_snapshot
    )
  );

  INSERT INTO public.daily_challenge_reroll_receipts (
    user_id,
    request_id,
    challenge_row_id,
    expected_challenge_id,
    cost,
    result
  ) VALUES (
    v_uid,
    p_request_id,
    p_challenge_row_id,
    p_expected_challenge_id,
    p_cost,
    v_result
  );

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer, uuid)
  TO authenticated, service_role;

-- The four-argument path stays available while old browser bundles drain from
-- caches. It serializes with the five-argument path and uses assignment change
-- as its replay proof because the old protocol did not supply a request UUID.
CREATE OR REPLACE FUNCTION public.reroll_daily_challenge(
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
  REROLL_COST constant integer := 1;
  v_uid uuid := auth.uid();
  v_row public.user_daily_challenges%ROWTYPE;
  v_balance integer;
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

  PERFORM public.fn_lock_daily_mission_user(v_uid);

  SELECT * INTO v_row
  FROM public.user_daily_challenges
  WHERE id = p_challenge_row_id
    AND user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'challenge not found');
  END IF;

  -- A committed legacy reroll changes this assignment before its response can
  -- be lost. Replay that settled result before rejecting the former price.
  IF v_row.challenge_id IS DISTINCT FROM p_expected_challenge_id THEN
    SELECT COALESCE(diamonds, 0)::integer INTO v_balance
    FROM public.profiles
    WHERE id = v_uid;

    RETURN jsonb_build_object(
      'success', true,
      'alreadyRerolled', true,
      'challengeId', v_row.challenge_id,
      'diamondBalance', COALESCE(v_balance, 0),
      'diamondsSpent', 0,
      'challenge', jsonb_build_object(
        'id', v_row.id,
        'challenge_id', v_row.challenge_id,
        'assigned_date', v_row.assigned_date,
        'progress', v_row.progress,
        'completed', v_row.completed,
        'claimed', v_row.claimed,
        'completed_at', v_row.completed_at,
        'name', v_row.challenge_name_snapshot,
        'description', v_row.challenge_description_snapshot,
        'challenge_type', v_row.challenge_type_snapshot,
        'requirement', v_row.requirement_snapshot,
        'chip_reward', 0,
        'diamond_reward', v_row.diamond_reward_snapshot,
        'tier', v_row.tier_snapshot
      )
    );
  END IF;

  IF p_cost IS DISTINCT FROM REROLL_COST THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'reroll price changed; refresh and try again'
    );
  END IF;

  RETURN public.reroll_daily_challenge(
    p_user_id,
    p_challenge_row_id,
    p_expected_challenge_id,
    p_cost,
    gen_random_uuid()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer)
  TO authenticated, service_role;

-- No callable path may retain the old ten-Diamond implementation.
DROP FUNCTION IF EXISTS public.reroll_daily_challenge_legacy_serialized_body(
  uuid,
  uuid,
  text,
  integer
);

COMMENT ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer, uuid) IS
'Replay-safe one-Diamond Daily Mission reroll. Exact historical ten-Diamond receipts replay with zero new spend; every fresh request is charged exactly one Diamond.';

COMMENT ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer) IS
'Compatibility Daily Mission reroll. Fresh calls cost one Diamond; a changed assignment safely replays a committed legacy call with zero new spend.';

COMMENT ON CONSTRAINT daily_challenge_reroll_receipts_settled_cost_check
  ON public.daily_challenge_reroll_receipts IS
'Preserves immutable historical ten-Diamond receipts and permits the current one-Diamond settlement price.';

DO $verify$
DECLARE
  v_five_arg_source text;
  v_four_arg_source text;
  v_four_arg_default text;
  v_five_arg_receipt_position integer;
  v_five_arg_price_position integer;
  v_four_arg_replay_position integer;
  v_four_arg_price_position integer;
  v_constraint_definition text;
  v_constraint_valid boolean;
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

  v_five_arg_receipt_position := position(
    'FROM public.daily_challenge_reroll_receipts' IN v_five_arg_source
  );
  v_five_arg_price_position := position(
    'IF p_cost IS DISTINCT FROM REROLL_COST' IN v_five_arg_source
  );
  v_four_arg_replay_position := position(
    'IF v_row.challenge_id IS DISTINCT FROM p_expected_challenge_id' IN v_four_arg_source
  );
  v_four_arg_price_position := position(
    'IF p_cost IS DISTINCT FROM REROLL_COST' IN v_four_arg_source
  );

  SELECT pg_get_constraintdef(c.oid), c.convalidated
  INTO v_constraint_definition, v_constraint_valid
  FROM pg_constraint c
  WHERE c.conrelid = 'public.daily_challenge_reroll_receipts'::regclass
    AND c.conname = 'daily_challenge_reroll_receipts_settled_cost_check';

  IF v_five_arg_source !~* 'REROLL_COST[[:space:]]+constant[[:space:]]+integer[[:space:]]*:=[[:space:]]*1[[:space:]]*;'
     OR v_five_arg_source ~* 'REROLL_COST[[:space:]]+constant[[:space:]]+integer[[:space:]]*:=[[:space:]]*10[[:space:]]*;'
     OR v_five_arg_source NOT ILIKE '%p_amount%:=%REROLL_COST%'
     OR v_five_arg_receipt_position <= 0
     OR v_five_arg_price_position <= 0
     OR v_five_arg_receipt_position >= v_five_arg_price_position
  THEN
    RAISE EXCEPTION 'Five-argument Daily Mission reroll price or replay order is incomplete';
  END IF;

  IF v_four_arg_source !~* 'REROLL_COST[[:space:]]+constant[[:space:]]+integer[[:space:]]*:=[[:space:]]*1[[:space:]]*;'
     OR v_four_arg_source ~* 'REROLL_COST[[:space:]]+constant[[:space:]]+integer[[:space:]]*:=[[:space:]]*10[[:space:]]*;'
     OR v_four_arg_source NOT ILIKE '%gen_random_uuid()%'
     OR v_four_arg_replay_position <= 0
     OR v_four_arg_price_position <= 0
     OR v_four_arg_replay_position >= v_four_arg_price_position
     OR v_four_arg_default IS DISTINCT FROM '1'
  THEN
    RAISE EXCEPTION 'Four-argument Daily Mission reroll compatibility is incomplete';
  END IF;

  IF v_constraint_valid IS DISTINCT FROM true
     OR v_constraint_definition NOT LIKE '%cost = ANY (ARRAY[1, 10])%'
     OR to_regprocedure(
       'public.reroll_daily_challenge_legacy_serialized_body(uuid,uuid,text,integer)'
     ) IS NOT NULL
  THEN
    RAISE EXCEPTION 'Daily Mission reroll settled-cost history is not constrained safely';
  END IF;

  IF NOT has_function_privilege(
       'authenticated',
       'public.reroll_daily_challenge(uuid,uuid,text,integer,uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated',
       'public.reroll_daily_challenge(uuid,uuid,text,integer)',
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
  THEN
    RAISE EXCEPTION 'Daily Mission reroll execute grants are unsafe';
  END IF;
END;
$verify$;

COMMIT;
