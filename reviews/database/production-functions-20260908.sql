CREATE OR REPLACE FUNCTION auth.role()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$function$
;
CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$
;
CREATE OR REPLACE FUNCTION public.deduct_diamonds(p_user_id uuid, p_amount integer, p_description text DEFAULT ''::text, p_transaction_type text DEFAULT 'game_cost'::text, p_source text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_reference_id text DEFAULT NULL::text, p_cooldown_seconds integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_current integer;
    v_new_balance integer;
    v_effective_type text;
    v_issuance_class text;
    v_counterparty text;
    v_existing_amount numeric;
    v_existing_type text;
    v_existing_counterparty text;
    v_existing_issuance_class text;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Amount must be a positive integer');
    END IF;
    IF COALESCE(auth.role(), '') <> 'service_role'
       AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_user_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Cannot deduct diamonds for another user');
    END IF;

    v_effective_type := COALESCE(p_source, p_transaction_type);

    -- Derive the destination before the replay check so the same reference
    -- cannot be moved to another recipient or revenue account.
    IF COALESCE(p_source, '') IN ('wallet_transfer', 'wallet_diamond_transfer', 'stream_gift')
       OR COALESCE(p_transaction_type, '') IN ('diamond_gift_sent', 'live_gift_sent') THEN
        v_issuance_class := 'transferred';
        v_counterparty := 'player:' || COALESCE(p_metadata->>'recipient_id', 'unknown');
    ELSE
        v_issuance_class := 'spend';
        v_counterparty := 'revenue:' || COALESCE(p_source, p_transaction_type, 'unknown');
    END IF;

    -- The profile lock serializes the first attempt and every concurrent
    -- replay. A second request cannot pass an early lookup, wait for the first
    -- debit to commit, and then fall through to a duplicate insert error.
    SELECT COALESCE(diamonds, 0)
      INTO v_current
      FROM public.profiles
     WHERE id = p_user_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'User not found');
    END IF;

    IF p_reference_id IS NOT NULL THEN
        SELECT dt.amount,
               COALESCE(dt.transaction_type, dt.type),
               dt.counterparty,
               dt.issuance_class
          INTO v_existing_amount,
               v_existing_type,
               v_existing_counterparty,
               v_existing_issuance_class
          FROM public.diamond_transactions AS dt
         WHERE dt.reference_id = p_reference_id
           AND dt.user_id = p_user_id
         LIMIT 1;

        IF FOUND THEN
            IF v_existing_amount IS DISTINCT FROM -p_amount
               OR v_existing_type IS DISTINCT FROM v_effective_type
               OR v_existing_counterparty IS DISTINCT FROM v_counterparty
               OR v_existing_issuance_class IS DISTINCT FROM v_issuance_class THEN
                RETURN jsonb_build_object(
                    'success', false,
                    'error', 'idempotency_conflict',
                    'balance', v_current,
                    'reference_id', p_reference_id
                );
            END IF;

            RETURN jsonb_build_object(
                'success', true,
                'balance', v_current,
                'charged', (-v_existing_amount)::integer,
                'transaction_type', v_existing_type,
                'reference_id', p_reference_id,
                'counterparty', v_existing_counterparty,
                'issuance_class', v_existing_issuance_class,
                'idempotent', true
            );
        END IF;
    END IF;

    IF v_current < p_amount THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Insufficient diamonds',
            'balance', v_current
        );
    END IF;

    IF p_cooldown_seconds > 0 THEN
        IF EXISTS (
            SELECT 1
              FROM public.diamond_transactions
             WHERE user_id = p_user_id
               AND transaction_type = v_effective_type
               AND created_at >= now() - make_interval(secs => p_cooldown_seconds)
        ) THEN
            RETURN jsonb_build_object(
                'success', false,
                'error', 'Please wait before sending again',
                'cooldown_active', true
            );
        END IF;
    END IF;

    UPDATE public.profiles
       SET diamonds = diamonds - p_amount,
           diamond_balance = diamonds - p_amount,
           updated_at = now()
     WHERE id = p_user_id
     RETURNING diamonds INTO v_new_balance;

    INSERT INTO public.diamond_transactions
        (user_id, amount, transaction_type, type, description, balance_after, metadata,
         reference_id, created_at, counterparty, issuance_class)
    VALUES
        (p_user_id, -p_amount, v_effective_type, v_effective_type, p_description,
         v_new_balance, p_metadata, p_reference_id, now(), v_counterparty, v_issuance_class);

    RETURN jsonb_build_object(
        'success', true,
        'balance', v_new_balance,
        'charged', p_amount,
        'transaction_type', v_effective_type,
        'reference_id', p_reference_id,
        'counterparty', v_counterparty,
        'issuance_class', v_issuance_class,
        'idempotent', false
    );
END;
$function$
;
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
;
