-- 20260908135005_horse_funding_receipts_keep_maintenance_gate.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The maintenance migration wrapped fn_horse_fund_from_treasury so an entry
-- purchase claims one immutable response receipt before it checks the freeze.
-- The later horse-funding migration correctly made the money core payload-bound,
-- authorization-before-replay and receipt-returning, but its source definition
-- again targeted the public function name. A source-order rebuild therefore
-- selected that later core as the public door and silently lost the maintenance
-- boundary. Production received the two migrations in the opposite application
-- order and currently has the intended two-layer shape; this forward migration
-- makes that composition authoritative for both production and source rebuilds.
--
-- The public door below owns maintenance serialization, authorization, the
-- immutable entry receipt and exact response validation. The private core owns
-- the treasury/seat transaction and its chip-ledger replay identity. They are
-- deliberately separate: neither an HTTP retry nor a maintenance boundary can
-- turn one busted horse into two treasury debits, and an unreadable outcome can
-- never be mistaken for permission to eject the seat.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
DECLARE
  v_public_md5 text;
  v_core_md5 text;
  v_input_shape text;
BEGIN
  IF to_regprocedure(
       'public.fn_horse_fund_from_treasury(uuid,uuid,numeric,uuid)'
     ) IS NULL
     OR to_regprocedure(
       'public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid,uuid,numeric,uuid)'
     ) IS NULL
     OR to_regprocedure(
       'public.fn_claim_entry_purchase_receipt(text,text,jsonb)'
     ) IS NULL
     OR to_regprocedure(
       'public.fn_record_entry_purchase_receipt(text,text,jsonb,jsonb)'
     ) IS NULL
     OR to_regprocedure(
       'public.fn_release_entry_purchase_claim(text,text,jsonb)'
     ) IS NULL
     OR to_regclass('public.entry_purchase_idempotency_receipts') IS NULL
     OR to_regprocedure('public.fn_entry_purchases_frozen()') IS NULL
     OR to_regprocedure('public.fn_assert_cash_chip_purchase_table(uuid)') IS NULL
     OR to_regprocedure('public.fn_actor_can_manage_club_treasury(uuid)') IS NULL THEN
    RAISE EXCEPTION
      'horse funding composition prerequisites are missing; do not replace an unknown money path';
  END IF;

  v_public_md5 := md5(pg_get_functiondef(
    'public.fn_horse_fund_from_treasury(uuid,uuid,numeric,uuid)'::regprocedure
  ));
  v_core_md5 := md5(pg_get_functiondef(
    'public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid,uuid,numeric,uuid)'::regprocedure
  ));

  /* Accept only complete, reviewed definition pairs.  Deliberately do not
     accept independent public/core marker sets or their cross-product: the
     two functions are one money-path contract.

     - composed-production: Stage-A public wrapper over the #3737 core;
     - source-order-drift: #3737 accidentally replaced the public wrapper,
       while the Stage-A rename retained the legacy private implementation;
     - stage-a-intermediate: the exact state after Stage A but before #3737;
     - already-composed-by-this-migration: the exact post-state, permitting a
       deployment runner to retry this migration without broadening the gate.

     The third pair matters to forward-only deploys whose migration ledger
     applied Stage A first; it is exact, not a generic "wrapper-looking" door. */
  CASE v_public_md5 || ':' || v_core_md5
    WHEN 'a55a603a52237a0358c5932ad19b2c54:2c3e3eea585854d7b83c64228c3322d2'
      THEN v_input_shape := 'composed-production';
    WHEN '5952ede69da9aeb3b22cefa3925d709f:cd674a8466a9b8a327f3e240dc32b6dc'
      THEN v_input_shape := 'source-order-drift';
    WHEN 'a55a603a52237a0358c5932ad19b2c54:cd674a8466a9b8a327f3e240dc32b6dc'
      THEN v_input_shape := 'stage-a-intermediate';
    WHEN '0da568b4ed0fad51f9ca3df0c14cbb01:b43177f12960b8ed9491fd46f9d40cc9'
      THEN v_input_shape := 'already-composed-by-this-migration';
    ELSE
      v_input_shape := NULL;
  END CASE;

  IF v_input_shape IS NULL THEN
    RAISE EXCEPTION
      'horse funding definition pair is unknown (public %, core %); re-review',
      v_public_md5,
      v_core_md5;
  END IF;

  IF NOT (SELECT c.relrowsecurity
            FROM pg_class c
           WHERE c.oid = 'public.entry_purchase_idempotency_receipts'::regclass)
     OR has_table_privilege(
          'anon', 'public.entry_purchase_idempotency_receipts', 'SELECT'
        )
     OR has_table_privilege(
          'authenticated', 'public.entry_purchase_idempotency_receipts', 'SELECT'
        )
     OR has_table_privilege(
          'service_role', 'public.entry_purchase_idempotency_receipts', 'SELECT'
        )
     OR has_table_privilege(
          'service_role', 'public.entry_purchase_idempotency_receipts', 'INSERT'
        )
     OR has_table_privilege(
          'service_role', 'public.entry_purchase_idempotency_receipts', 'UPDATE'
        )
     OR has_table_privilege(
          'service_role', 'public.entry_purchase_idempotency_receipts', 'DELETE'
        )
     OR has_function_privilege(
          'anon', 'public.fn_claim_entry_purchase_receipt(text,text,jsonb)', 'EXECUTE'
        )
     OR has_function_privilege(
          'authenticated', 'public.fn_claim_entry_purchase_receipt(text,text,jsonb)', 'EXECUTE'
        )
     OR has_function_privilege(
          'service_role', 'public.fn_claim_entry_purchase_receipt(text,text,jsonb)', 'EXECUTE'
        )
     OR has_function_privilege(
          'anon', 'public.fn_record_entry_purchase_receipt(text,text,jsonb,jsonb)', 'EXECUTE'
        )
     OR has_function_privilege(
          'authenticated', 'public.fn_record_entry_purchase_receipt(text,text,jsonb,jsonb)', 'EXECUTE'
        )
     OR has_function_privilege(
          'service_role', 'public.fn_record_entry_purchase_receipt(text,text,jsonb,jsonb)', 'EXECUTE'
        )
     OR has_function_privilege(
          'anon', 'public.fn_release_entry_purchase_claim(text,text,jsonb)', 'EXECUTE'
        )
     OR has_function_privilege(
          'authenticated', 'public.fn_release_entry_purchase_claim(text,text,jsonb)', 'EXECUTE'
        )
     OR has_function_privilege(
          'service_role', 'public.fn_release_entry_purchase_claim(text,text,jsonb)', 'EXECUTE'
        ) THEN
    RAISE EXCEPTION
      'entry funding receipt table/helper ACL boundary is not canonical';
  END IF;

  RAISE NOTICE 'horse funding input shape: %', v_input_shape;
END;
$preflight$;

/* The #3737 receipt-bound money function is the private core. Re-state the
   audited definition under its implementation name so a source parser cannot
   mistake the core for the public maintenance door merely because #3737 was
   authored later than the original wrapper migration. */
CREATE OR REPLACE FUNCTION public.fn_horse_fund_from_treasury_before_maintenance_gate(
  p_table_id uuid,
  p_user_id uuid,
  p_amount numeric,
  p_op_id uuid DEFAULT NULL::uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_treasury numeric;
  v_new_stack numeric;
  v_prior public.chip_ledger;
  v_skip text := COALESCE(current_setting('app.ledger_autoskip_clubs', true), '');
BEGIN
  IF p_table_id IS NULL OR p_user_id IS NULL OR p_amount IS NULL OR p_amount <= 0
     OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'table, user and positive amount required'
    );
  END IF;

  SELECT club_id
    INTO v_club_id
    FROM public.tables
   WHERE id = p_table_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'table has no club');
  END IF;

  IF NOT public.fn_actor_can_manage_club_treasury(v_club_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'not authorized to fund from club treasury'
    );
  END IF;

  IF p_op_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('horse_fund:' || p_op_id::text, 0)
    );
    SELECT *
      INTO v_prior
      FROM public.chip_ledger
     WHERE idempotency_key = 'horse_fund:' || p_op_id::text;
    IF FOUND THEN
      IF v_prior.table_id IS DISTINCT FROM p_table_id
         OR v_prior.club_id IS DISTINCT FROM v_club_id
         OR v_prior.amount IS DISTINCT FROM p_amount
         OR v_prior.metadata->>'user_id' IS DISTINCT FROM p_user_id::text
         OR v_prior.category IS DISTINCT FROM 'horse_funding'
         OR v_prior.from_type IS DISTINCT FROM 'club_treasury'
         OR v_prior.to_type IS DISTINCT FROM 'table_stack' THEN
        RAISE EXCEPTION 'Horse funding identity reused with different payload'
          USING ERRCODE = '22023';
      END IF;
      RETURN jsonb_build_object(
        'success', true,
        'replayed', true,
        'op_id', p_op_id,
        'table_id', p_table_id,
        'user_id', p_user_id,
        'club_id', v_club_id,
        'amount', p_amount,
        'new_stack', v_prior.metadata->'new_stack',
        'treasury_after', v_prior.metadata->'treasury_after'
      );
    END IF;
  END IF;

  SELECT COALESCE(chip_treasury, 0)
    INTO v_treasury
    FROM public.clubs
   WHERE id = v_club_id
   FOR UPDATE;
  IF v_treasury IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;
  IF v_treasury < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient club treasury',
      'treasury', v_treasury,
      'needed', p_amount
    );
  END IF;

  UPDATE public.table_seats
     SET stack = COALESCE(stack, 0) + p_amount
   WHERE table_id = p_table_id
     AND user_id = p_user_id
     AND left_at IS NULL
  RETURNING stack INTO v_new_stack;

  IF v_new_stack IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'no active seat for user at table'
    );
  END IF;

  PERFORM public.fn_cash_session_add_baseline(p_user_id, p_table_id, p_amount);

  PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
  UPDATE public.clubs
     SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount,
         updated_at = NOW()
   WHERE id = v_club_id;
  PERFORM set_config('app.ledger_autoskip_clubs', v_skip, true);

  INSERT INTO public.chip_transactions (
    id,
    club_id,
    from_user_id,
    to_user_id,
    amount,
    transaction_type,
    notes,
    balance_after,
    created_at
  ) VALUES (
    gen_random_uuid(),
    v_club_id,
    NULL,
    p_user_id,
    p_amount,
    'horse_treasury_funding',
    'Horse buy-in/rebuy funded from club treasury',
    v_treasury - p_amount,
    NOW()
  );

  BEGIN
    INSERT INTO public.chip_ledger (
      performed_by,
      from_type,
      from_entity_id,
      to_type,
      to_entity_id,
      amount,
      category,
      club_id,
      table_id,
      description,
      idempotency_key,
      metadata
    ) VALUES (
      COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
      'club_treasury',
      v_club_id,
      'table_stack',
      p_table_id,
      p_amount,
      'horse_funding',
      v_club_id,
      p_table_id,
      'Buy-in/rebuy funded from club treasury (fn_horse_fund_from_treasury) for '
        || p_user_id::text,
      CASE
        WHEN p_op_id IS NULL THEN NULL
        ELSE 'horse_fund:' || p_op_id::text
      END,
      jsonb_build_object(
        'user_id', p_user_id,
        'op_id', p_op_id,
        'door', 'fn_horse_fund_from_treasury',
        'new_stack', v_new_stack,
        'treasury_after', v_treasury - p_amount
      )
    );
  EXCEPTION WHEN OTHERS THEN
    -- A journal failure aborts the entire chip movement. Bare RAISE preserves
    -- the original SQLSTATE, DETAIL, HINT and context for the caller's retry.
    RAISE;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'new_stack', v_new_stack,
    'treasury_after', v_treasury - p_amount,
    'op_id', p_op_id,
    'table_id', p_table_id,
    'user_id', p_user_id,
    'club_id', v_club_id,
    'amount', p_amount
  );
END;
$function$;

REVOKE ALL ON FUNCTION
  public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid, uuid, numeric, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

/* The public door preserves Stage A's first-lock maintenance boundary and
   immutable response receipt, while retaining #3737's authorization-before-
   replay rule and exact scope/amount/stack acknowledgement. */
CREATE OR REPLACE FUNCTION public.fn_horse_fund_from_treasury(
  p_table_id uuid,
  p_user_id uuid,
  p_amount numeric,
  p_op_id uuid DEFAULT NULL::uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_club_id uuid;
  v_request jsonb;
  v_response jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  IF p_table_id IS NULL OR p_user_id IS NULL OR p_amount IS NULL OR p_amount <= 0
     OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'table, user and positive amount required'
    );
  END IF;

  SELECT club_id
    INTO v_club_id
    FROM public.tables
   WHERE id = p_table_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'table has no club');
  END IF;
  IF NOT public.fn_actor_can_manage_club_treasury(v_club_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'not authorized to fund from club treasury'
    );
  END IF;

  v_request := jsonb_build_object(
    'door', 'fn_horse_fund_from_treasury',
    'table_id', p_table_id,
    'user_id', p_user_id,
    'amount', p_amount
  );
  v_response := public.fn_claim_entry_purchase_receipt(
    'horse_funding', p_op_id::text, v_request
  );
  IF NOT COALESCE((v_response->>'claimed')::boolean, false) THEN
    v_response := v_response->'response';
    IF v_response->>'success' IS DISTINCT FROM 'true'
       OR v_response->>'op_id' IS DISTINCT FROM p_op_id::text
       OR v_response->>'table_id' IS DISTINCT FROM p_table_id::text
       OR v_response->>'user_id' IS DISTINCT FROM p_user_id::text
       OR v_response->>'club_id' IS DISTINCT FROM v_club_id::text
       OR (v_response->>'amount')::numeric IS DISTINCT FROM p_amount
       OR jsonb_typeof(v_response->'new_stack') IS DISTINCT FROM 'number'
       OR (v_response->>'new_stack')::numeric < p_amount THEN
      RAISE EXCEPTION
        'HORSE_FUNDING_RECEIPT_INVALID: immutable response does not match the authorized request'
        USING ERRCODE = '55000';
    END IF;
    RETURN v_response || jsonb_build_object('replayed', true);
  END IF;

  IF p_op_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.chip_ledger l
     WHERE l.idempotency_key = 'horse_fund:' || p_op_id::text
  ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: this historical horse key has no exact response receipt'
      USING ERRCODE = '55000';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    PERFORM public.fn_release_entry_purchase_claim(
      'horse_funding', p_op_id::text, v_request
    );
    RETURN jsonb_build_object(
      'success', false,
      'deferred', true,
      'error', 'PLATFORM_FROZEN: scheduled maintenance has deferred this horse rebuy'
    );
  END IF;

  PERFORM public.fn_assert_cash_chip_purchase_table(p_table_id);
  v_response := public.fn_horse_fund_from_treasury_before_maintenance_gate(
    p_table_id, p_user_id, p_amount, p_op_id
  );
  IF NOT COALESCE((v_response->>'success')::boolean, false) THEN
    PERFORM public.fn_release_entry_purchase_claim(
      'horse_funding', p_op_id::text, v_request
    );
    RETURN v_response;
  END IF;

  IF v_response->>'op_id' IS DISTINCT FROM p_op_id::text
     OR v_response->>'table_id' IS DISTINCT FROM p_table_id::text
     OR v_response->>'user_id' IS DISTINCT FROM p_user_id::text
     OR v_response->>'club_id' IS DISTINCT FROM v_club_id::text
     OR (v_response->>'amount')::numeric IS DISTINCT FROM p_amount
     OR jsonb_typeof(v_response->'new_stack') IS DISTINCT FROM 'number'
     OR (v_response->>'new_stack')::numeric < p_amount THEN
    RAISE EXCEPTION
      'HORSE_FUNDING_RECEIPT_INVALID: money core returned a mismatched acknowledgement'
      USING ERRCODE = '55000';
  END IF;

  RETURN public.fn_record_entry_purchase_receipt(
    'horse_funding', p_op_id::text, v_request, v_response
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_horse_fund_from_treasury(uuid, uuid, numeric, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_horse_fund_from_treasury(uuid, uuid, numeric, uuid)
  TO service_role;

DO $postcondition$
DECLARE
  v_public text;
  v_core text;
BEGIN
  v_public := pg_get_functiondef(
    'public.fn_horse_fund_from_treasury(uuid,uuid,numeric,uuid)'::regprocedure
  );
  v_core := pg_get_functiondef(
    'public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid,uuid,numeric,uuid)'::regprocedure
  );

  IF md5(v_public) || ':' || md5(v_core)
       IS DISTINCT FROM
       '0da568b4ed0fad51f9ca3df0c14cbb01:b43177f12960b8ed9491fd46f9d40cc9'
     OR position('pg_advisory_xact_lock_shared(530090, 1)' IN v_public) = 0
     OR position('fn_actor_can_manage_club_treasury' IN v_public) = 0
     OR position('fn_claim_entry_purchase_receipt' IN v_public) = 0
     OR position('fn_entry_purchases_frozen()' IN v_public) = 0
     OR position('fn_horse_fund_from_treasury_before_maintenance_gate' IN v_public) = 0
     OR position('fn_record_entry_purchase_receipt' IN v_public) = 0
     OR position('HORSE_FUNDING_RECEIPT_INVALID' IN v_public) = 0
     OR position('v_prior public.chip_ledger' IN v_core) = 0
     OR position('Horse funding identity reused with different payload' IN v_core) = 0
     OR position('fn_cash_session_add_baseline' IN v_core) = 0
     OR position('horse_fund:' IN v_core) = 0 THEN
    RAISE EXCEPTION 'horse funding wrapper/core composition is incomplete';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'public.fn_horse_fund_from_treasury(uuid,uuid,numeric,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_horse_fund_from_treasury(uuid,uuid,numeric,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.fn_horse_fund_from_treasury(uuid,uuid,numeric,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid,uuid,numeric,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid,uuid,numeric,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.fn_horse_fund_from_treasury_before_maintenance_gate(uuid,uuid,numeric,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'horse funding wrapper/core ACL boundary is not canonical';
  END IF;
END;
$postcondition$;

NOTIFY pgrst, 'reload schema';

COMMIT;
