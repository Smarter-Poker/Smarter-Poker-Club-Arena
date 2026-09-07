CREATE OR REPLACE FUNCTION public.fn_use_throwable_v2(p_throwable_id text, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid         uuid := auth.uid();
  v_vip         boolean;
  v_lifetime    boolean;
  v_used        integer;
  v_free        constant integer := 500;
  v_credit      uuid;
  v_left        integer;
  v_res         jsonb;
  v_result      jsonb;
  v_cached_id   text;
  v_cached      jsonb;
  v_month_start timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Authentication Required');
  END IF;
  IF p_throwable_id IS NULL OR length(p_throwable_id) = 0 OR length(p_throwable_id) > 64 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid Throwable');
  END IF;
  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Secure Request Id Required');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('throwable:request:' || v_uid::text || ':' || p_request_id::text, 0)
  );

  SELECT r.throwable_id, r.result
    INTO v_cached_id, v_cached
    FROM public.throwable_use_receipts r
   WHERE r.user_id = v_uid
     AND r.request_id = p_request_id;

  IF v_cached IS NOT NULL THEN
    IF v_cached_id IS DISTINCT FROM p_throwable_id THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Request Id Already Used For Another Throwable'
      );
    END IF;
    RETURN v_cached || jsonb_build_object(
      'diamonds_spent', 0,
      'original_diamonds_spent',
        COALESCE(
          (v_cached->>'original_diamonds_spent')::integer,
          (v_cached->>'diamonds_spent')::integer,
          0
        ),
      'idempotent', true,
      'consumed', false
    );
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('throwable:' || v_uid::text, 0));

  SELECT
    COALESCE(p.is_vip, false)
      AND (p.vip_tier IS NOT DISTINCT FROM 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now()),
    COALESCE(p.is_vip, false) AND p.vip_tier IS NOT DISTINCT FROM 'lifetime'
    INTO v_vip, v_lifetime
    FROM public.profiles p
   WHERE p.id = v_uid;

  IF v_vip IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unknown User');
  END IF;

  -- Unlimited means no inventory meter, not unlimited write throughput. The
  -- visible selector already has the same 1.5-second animation cooldown; pin it
  -- here under the per-account advisory lock so a crafted browser client cannot
  -- turn the Lifetime audit trail into an unbounded database-write endpoint.
  IF EXISTS (
    SELECT 1
      FROM public.throw_usage tu
     WHERE tu.user_id = v_uid
       AND tu.created_at > clock_timestamp() - interval '1500 milliseconds'
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Please Wait Before Sending Another Throwable',
      'code', 'RATE_LIMITED',
      'retry_after_ms', 1500
    );
  END IF;

  IF v_lifetime THEN
    INSERT INTO public.throw_usage (user_id, throwable_id, paid_diamonds)
    VALUES (v_uid, p_throwable_id, false);

    v_result := jsonb_build_object(
      'success', true,
      'paid', false,
      'source', 'lifetime_vip',
      'unlimited', true,
      'diamonds_spent', 0,
      'idempotent', false,
      'consumed', true
    );
    INSERT INTO public.throwable_use_receipts (user_id, request_id, throwable_id, result)
    VALUES (v_uid, p_request_id, p_throwable_id, v_result);
    RETURN v_result;
  END IF;

  IF v_vip THEN
    SELECT count(*) INTO v_used
      FROM public.throw_usage
     WHERE user_id = v_uid
       AND created_at >= v_month_start;

    IF v_used < v_free THEN
      INSERT INTO public.throw_usage (user_id, throwable_id, paid_diamonds)
      VALUES (v_uid, p_throwable_id, false);

      v_result := jsonb_build_object(
        'success', true,
        'paid', false,
        'source', 'vip_monthly',
        'free_remaining', v_free - v_used - 1,
        'diamonds_spent', 0,
        'idempotent', false,
        'consumed', true
      );
      INSERT INTO public.throwable_use_receipts (user_id, request_id, throwable_id, result)
      VALUES (v_uid, p_request_id, p_throwable_id, v_result);
      RETURN v_result;
    END IF;
  END IF;

  SELECT id INTO v_credit
    FROM public.feature_purchases
   WHERE user_id = v_uid
     AND feature = 'throwable'
     AND COALESCE(uses_remaining, 0) > 0
     AND (expires_at IS NULL OR expires_at > now())
   ORDER BY created_at ASC
   LIMIT 1
   FOR UPDATE SKIP LOCKED;

  IF v_credit IS NOT NULL THEN
    UPDATE public.feature_purchases
       SET uses_remaining = uses_remaining - 1
     WHERE id = v_credit
     RETURNING uses_remaining INTO v_left;

    INSERT INTO public.throw_usage (user_id, throwable_id, paid_diamonds)
    VALUES (v_uid, p_throwable_id, false);

    v_result := jsonb_build_object(
      'success', true,
      'paid', false,
      'source', 'purchased',
      'from_pack', true,
      'pack_remaining', v_left,
      'diamonds_spent', 0,
      'idempotent', false,
      'consumed', true
    );
    INSERT INTO public.throwable_use_receipts (user_id, request_id, throwable_id, result)
    VALUES (v_uid, p_request_id, p_throwable_id, v_result);
    RETURN v_result;
  END IF;

  v_res := public.deduct_diamonds(
    v_uid,
    1,
    'Throwable: ' || p_throwable_id,
    'throwable'
  );

  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', COALESCE(v_res->>'error', 'Diamond Charge Failed')
    );
  END IF;

  INSERT INTO public.throw_usage (user_id, throwable_id, paid_diamonds)
  VALUES (v_uid, p_throwable_id, true);

  v_result := jsonb_build_object(
    'success', true,
    'paid', true,
    'source', 'diamonds',
    'diamonds_spent', 1,
    'balance', (v_res->>'balance')::numeric,
    'idempotent', false,
    'consumed', true
  );
  INSERT INTO public.throwable_use_receipts (user_id, request_id, throwable_id, result)
  VALUES (v_uid, p_request_id, p_throwable_id, v_result);
  RETURN v_result;
END;
$function$
