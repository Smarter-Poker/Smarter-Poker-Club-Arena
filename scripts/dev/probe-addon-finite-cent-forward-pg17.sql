\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.historical_pending_snapshot()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', id,
      'table_id', table_id,
      'user_id', user_id,
      'amount', amount::text,
      'kind', kind,
      'created_at', created_at,
      'resolved_at', resolved_at,
      'applied_to_stack', applied_to_stack::text,
      'refunded', refunded::text
    ) ORDER BY id
  )
    FROM public.table_pending_addons
   WHERE kind = 'historic'
$$;

CREATE OR REPLACE FUNCTION pg_temp.historical_idempotency_snapshot()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_agg(
    jsonb_build_object('key', key, 'amount', amount::text)
    ORDER BY key
  )
    FROM public.table_addon_idempotency
   WHERE key LIKE 'historic:%'
$$;

DO $history_was_not_rewritten$
BEGIN
  IF (SELECT pending FROM public.probe_historical_snapshot)
       IS DISTINCT FROM pg_temp.historical_pending_snapshot()
     OR (SELECT idempotency FROM public.probe_historical_snapshot)
       IS DISTINCT FROM pg_temp.historical_idempotency_snapshot() THEN
    RAISE EXCEPTION 'the forward migrations rewrote settled add-on history';
  END IF;
END;
$history_was_not_rewritten$;

DO $constraints_are_not_valid_but_enforce_new_writes$
DECLARE
  v_target integer;
  v_bad text;
  v_counter integer := 0;
  v_sql text;
  v_caught boolean;
BEGIN
  IF (
    SELECT count(*)
      FROM pg_constraint c
     WHERE c.convalidated IS FALSE
       AND (c.conrelid, c.conname) IN (
         ('public.table_pending_addons'::regclass,
          'table_pending_addons_amount_is_cents'),
         ('public.table_pending_addons'::regclass,
          'table_pending_addons_applied_is_cents'),
         ('public.table_pending_addons'::regclass,
          'table_pending_addons_refunded_is_cents'),
         ('public.table_addon_idempotency'::regclass,
          'table_addon_idempotency_amount_is_cents')
       )
  ) <> 4 THEN
    RAISE EXCEPTION 'the four replacement constraints are not NOT VALID';
  END IF;

  FOR v_target IN 1..4 LOOP
    FOREACH v_bad IN ARRAY ARRAY[
      '''NaN''::numeric',
      '''Infinity''::numeric',
      '''-Infinity''::numeric',
      '1.001::numeric'
    ]
    LOOP
      v_counter := v_counter + 1;
      v_sql := CASE v_target
        WHEN 1 THEN format(
          'INSERT INTO public.table_pending_addons(id,table_id,user_id,amount,kind) VALUES(md5(%L)::uuid,%L::uuid,%L::uuid,%s,%L)',
          'amount:' || v_counter,
          '40000000-0000-4000-8000-000000000001',
          '50000000-0000-4000-8000-000000000001',
          v_bad,
          'probe-invalid'
        )
        WHEN 2 THEN format(
          'INSERT INTO public.table_pending_addons(id,table_id,user_id,amount,kind,applied_to_stack) VALUES(md5(%L)::uuid,%L::uuid,%L::uuid,1,%L,%s)',
          'applied:' || v_counter,
          '40000000-0000-4000-8000-000000000002',
          '50000000-0000-4000-8000-000000000002',
          'probe-invalid',
          v_bad
        )
        WHEN 3 THEN format(
          'INSERT INTO public.table_pending_addons(id,table_id,user_id,amount,kind,refunded) VALUES(md5(%L)::uuid,%L::uuid,%L::uuid,1,%L,%s)',
          'refunded:' || v_counter,
          '40000000-0000-4000-8000-000000000003',
          '50000000-0000-4000-8000-000000000003',
          'probe-invalid',
          v_bad
        )
        WHEN 4 THEN format(
          'INSERT INTO public.table_addon_idempotency(key,amount) VALUES(%L,%s)',
          'probe-invalid:' || v_counter,
          v_bad
        )
      END;

      v_caught := false;
      BEGIN
        EXECUTE v_sql;
      EXCEPTION WHEN check_violation THEN
        v_caught := true;
      END;
      IF NOT v_caught THEN
        RAISE EXCEPTION 'constraint target % admitted %', v_target, v_bad;
      END IF;
    END LOOP;
  END LOOP;

  IF EXISTS (
       SELECT 1 FROM public.table_pending_addons WHERE kind = 'probe-invalid'
     ) OR EXISTS (
       SELECT 1 FROM public.table_addon_idempotency
        WHERE key LIKE 'probe-invalid:%'
     ) THEN
    RAISE EXCEPTION 'a rejected constraint probe left a row behind';
  END IF;

  INSERT INTO public.table_pending_addons(
    id, table_id, user_id, amount, kind, applied_to_stack, refunded
  ) VALUES (
    '60000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000004',
    '50000000-0000-4000-8000-000000000004',
    1.23, 'probe-valid', 1.20, 0.03
  );
  INSERT INTO public.table_addon_idempotency(key, amount)
  VALUES ('probe-valid', 1.23);
END;
$constraints_are_not_valid_but_enforce_new_writes$;

DO $amount_doors_refuse_before_claim$
DECLARE
  v_amount text;
  v_caught boolean;
  v_counter integer := 0;
BEGIN
  FOREACH v_amount IN ARRAY ARRAY[
    'NULL::numeric',
    '''NaN''::numeric',
    '''Infinity''::numeric',
    '''-Infinity''::numeric',
    '1.001::numeric'
  ]
  LOOP
    v_counter := v_counter + 1;
    v_caught := false;
    BEGIN
      EXECUTE format(
        'SELECT public.atomic_table_addon(%L::uuid,%L::uuid,%s,true,%L)',
        '70000000-0000-4000-8000-000000000001',
        '70000000-0000-4000-8000-000000000002',
        v_amount,
        'bad-addon:' || v_counter
      );
    EXCEPTION WHEN SQLSTATE '22003' THEN
      v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'atomic_table_addon admitted %', v_amount;
    END IF;

    v_caught := false;
    BEGIN
      EXECUTE format(
        'SELECT public.atomic_table_buyin(%L::uuid,%L::uuid,1,%s,false,NULL,%L::uuid)',
        '70000000-0000-4000-8000-000000000001',
        '70000000-0000-4000-8000-000000000002',
        v_amount,
        md5('bad-buyin:' || v_counter)::uuid
      );
    EXCEPTION WHEN SQLSTATE '22003' THEN
      v_caught := true;
    END;
    IF NOT v_caught THEN
      RAISE EXCEPTION 'atomic_table_buyin admitted %', v_amount;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.probe_receipt_claims) THEN
    RAISE EXCEPTION 'a refused amount burned an idempotency receipt';
  END IF;

  IF public.atomic_table_addon(
       '70000000-0000-4000-8000-000000000001',
       '70000000-0000-4000-8000-000000000002',
       1.23,
       true,
       'valid-addon'
     ) IS DISTINCT FROM 123::numeric THEN
    RAISE EXCEPTION 'valid add-on did not reach the receipt claim';
  END IF;
  PERFORM public.atomic_table_buyin(
    '70000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000002',
    1,
    1.23,
    false,
    NULL,
    '70000000-0000-4000-8000-000000000003'
  );
  IF (SELECT count(*) FROM public.probe_receipt_claims) <> 2 THEN
    RAISE EXCEPTION 'valid amount did not prove the receipt-claim fixture';
  END IF;
END;
$amount_doors_refuse_before_claim$;

CREATE OR REPLACE FUNCTION pg_temp.make_post_commit_probe(p_addon_id uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_hand_id uuid := md5('hand:' || p_addon_id::text)::uuid;
  v_table_id uuid;
  v_payload jsonb;
BEGIN
  SELECT table_id INTO STRICT v_table_id
    FROM public.table_pending_addons
   WHERE id = p_addon_id;
  v_payload := jsonb_build_object(
    'time_banks', '[]'::jsonb,
    'rake', 'null'::jsonb,
    'bbj_contribution', 'null'::jsonb,
    'promo_playthrough', '[]'::jsonb,
    'insurance', '[]'::jsonb,
    'pending_addons', jsonb_build_object(
      'enabled', true,
      'max_buy_in', 100,
      'ids', jsonb_build_array(p_addon_id)
    )
  );
  INSERT INTO public.hand_atomic_commits(
    hand_id, table_id, hand_number, post_commit_payload,
    post_commit_payload_hash
  ) VALUES (
    v_hand_id,
    v_table_id,
    1,
    v_payload,
    encode(
      extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'),
      'hex'
    )
  );
  RETURN v_hand_id;
END;
$$;

DO $historical_receipts_are_strict_and_replayable$
DECLARE
  v_addon_id uuid;
  v_hand_id uuid;
  v_result jsonb;
  v_caught boolean;
BEGIN
  v_addon_id := '10000000-0000-4000-8000-000000000001';
  v_hand_id := pg_temp.make_post_commit_probe(v_addon_id);
  v_result := public.fn_ca_process_hand_post_commit_obligations(v_hand_id);
  IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE
     OR (v_result->>'pending_addons')::integer <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.hand_atomic_commits
        WHERE hand_id = v_hand_id
          AND post_commit_completed_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'valid historical cent receipt was refused: %', v_result;
  END IF;

  FOREACH v_addon_id IN ARRAY ARRAY[
    '10000000-0000-4000-8000-000000000002'::uuid,
    '10000000-0000-4000-8000-000000000003'::uuid,
    '10000000-0000-4000-8000-000000000004'::uuid,
    '10000000-0000-4000-8000-000000000005'::uuid
  ]
  LOOP
    v_hand_id := pg_temp.make_post_commit_probe(v_addon_id);
    v_caught := false;
    BEGIN
      PERFORM public.fn_ca_process_hand_post_commit_obligations(v_hand_id);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF position('incomplete resolution receipt' IN SQLERRM) <= 0 THEN
        RAISE;
      END IF;
      v_caught := true;
    END;
    IF NOT v_caught OR EXISTS (
      SELECT 1 FROM public.hand_atomic_commits
       WHERE hand_id = v_hand_id
         AND post_commit_completed_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'invalid historical receipt % was admitted', v_addon_id;
    END IF;
  END LOOP;

  IF (SELECT pending FROM public.probe_historical_snapshot)
       IS DISTINCT FROM pg_temp.historical_pending_snapshot()
     OR (SELECT idempotency FROM public.probe_historical_snapshot)
       IS DISTINCT FROM pg_temp.historical_idempotency_snapshot() THEN
    RAISE EXCEPTION 'post-commit receipt proof rewrote settled history';
  END IF;
END;
$historical_receipts_are_strict_and_replayable$;

SELECT 'PostgreSQL 17 finite-cent add-on forward probes passed.' AS result;
