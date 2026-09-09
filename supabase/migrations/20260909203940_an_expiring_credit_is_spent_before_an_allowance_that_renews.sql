-- 20260909203940_an_expiring_credit_is_spent_before_an_allowance_that_renews.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- AN EXPIRING CREDIT IS SPENT BEFORE AN ALLOWANCE THAT RENEWS.
-- (Dan, 2026-09-09, daily bonus audit: "fix ANY AND ALL BUGS, GAPS ... and
--  get this working the way its supposed to be working")
--
-- THE GAP. The Daily Club Arena Bonus grants throwables, rabbit hunts and
-- time bank as feature_purchases credits at cost 0 that expire seven days
-- after the claim, and its sheet tells the player "Yours For 7 Days". The
-- three consumers draw in this order:
--
--   fn_use_throwable_v2        lifetime VIP -> 30 member / 500 VIP a month -> packs -> 1 diamond
--   fn_consume_rabbit_hunt_v2  lifetime VIP -> 100 VIP a month -> packs -> diamonds
--   fn_consume_time_bank       lifetime VIP -> 120 VIP seconds a month -> packs
--
-- so a bonus credit is reached only after the monthly allowance is spent
-- (30 throws for a member, in the same calendar month, inside the seven-day
-- window). Measured on production 2026-09-09: both throwable credits the
-- bonus has granted so far still hold every use and expire 2026-09-15. The
-- sheet was promising a thing the tables would not deliver.
--
-- THE RULE. A credit that expires is spent before an allowance that renews.
-- Purchased packs never expire (expires_at IS NULL, every row in production),
-- so the only credits this reorders are the ones that would otherwise lapse,
-- soonest-to-expire first. The allowance is not reduced, only deferred: a
-- member who claims two bonus throwables and throws thirty-two in a month
-- pays for none of them either way; the difference is that the two no longer
-- evaporate.
--
-- Lifetime VIP is untouched: unlimited means no meter, and the receipt shape
-- the client reads for it ('unlimited': true) stays exactly as it is.
--
-- Bodies are the live definitions with the one step inserted; nothing else
-- moves. The receipt for a drawn expiring credit keeps 'source': 'purchased'
-- (the shape every client already handles) and adds 'credit_source' (the
-- feature_purchases.source, e.g. daily_bonus) and 'expiring': true.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------------
-- 1. Throwables
-- ---------------------------------------------------------------------------
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
  v_member_free constant integer := 30;
  v_limit       integer;
  v_credit      uuid;
  v_credit_src  text;
  v_left        integer;
  v_res         jsonb;
  v_result      jsonb;
  v_cached_id   text;
  v_cached      jsonb;
  v_month_start timestamptz;
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

  v_month_start := date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  SELECT
    COALESCE(p.is_vip, false)
      AND (p.vip_tier IS NOT DISTINCT FROM 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > clock_timestamp()),
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
    INSERT INTO public.throw_usage (user_id, throwable_id, paid_diamonds, created_at)
    VALUES (v_uid, p_throwable_id, false, clock_timestamp());

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

  -- AN EXPIRING CREDIT IS SPENT BEFORE AN ALLOWANCE THAT RENEWS. A daily
  -- bonus credit lives seven days; the monthly allowance comes back on the
  -- first. Soonest to expire first.
  LOOP
    SELECT id, source INTO v_credit, v_credit_src
      FROM public.feature_purchases
     WHERE user_id = v_uid
       AND feature = 'throwable'
       AND COALESCE(uses_remaining, 0) > 0
       AND expires_at IS NOT NULL
       AND expires_at > clock_timestamp()
     ORDER BY expires_at ASC, created_at ASC
     LIMIT 1
     FOR UPDATE;

    EXIT WHEN v_credit IS NULL;
    UPDATE public.feature_purchases
       SET uses_remaining = uses_remaining - 1
     WHERE id = v_credit
       AND user_id = v_uid
       AND COALESCE(uses_remaining, 0) > 0
       AND (expires_at IS NULL OR expires_at > clock_timestamp())
     RETURNING uses_remaining INTO v_left;
    EXIT WHEN FOUND;
  END LOOP;

  IF v_credit IS NOT NULL THEN
    INSERT INTO public.throw_usage (user_id, throwable_id, paid_diamonds, created_at)
    VALUES (v_uid, p_throwable_id, false, clock_timestamp());

    v_result := jsonb_build_object(
      'success', true,
      'paid', false,
      'source', 'purchased',
      'from_pack', true,
      'expiring', true,
      'credit_source', v_credit_src,
      'pack_remaining', v_left,
      'diamonds_spent', 0,
      'idempotent', false,
      'consumed', true
    );
    INSERT INTO public.throwable_use_receipts (user_id, request_id, throwable_id, result)
    VALUES (v_uid, p_request_id, p_throwable_id, v_result);
    RETURN v_result;
  END IF;

  v_limit := CASE WHEN v_vip THEN v_free ELSE v_member_free END;
  IF v_limit > 0 THEN
    SELECT count(*) INTO v_used
      FROM public.throw_usage
     WHERE user_id = v_uid
       AND created_at >= v_month_start;

    IF v_used < v_limit THEN
      INSERT INTO public.throw_usage (user_id, throwable_id, paid_diamonds, created_at)
      VALUES (v_uid, p_throwable_id, false, clock_timestamp());

      v_result := jsonb_build_object(
        'success', true,
        'paid', false,
        'source', CASE WHEN v_vip THEN 'vip_monthly' ELSE 'member_monthly' END,
        'free_remaining', v_limit - v_used - 1,
        'diamonds_spent', 0,
        'idempotent', false,
        'consumed', true
      );
      INSERT INTO public.throwable_use_receipts (user_id, request_id, throwable_id, result)
      VALUES (v_uid, p_request_id, p_throwable_id, v_result);
      RETURN v_result;
    END IF;
  END IF;

  LOOP
    SELECT id, source INTO v_credit, v_credit_src
      FROM public.feature_purchases
     WHERE user_id = v_uid
       AND feature = 'throwable'
       AND COALESCE(uses_remaining, 0) > 0
       AND (expires_at IS NULL OR expires_at > clock_timestamp())
     ORDER BY created_at ASC
     LIMIT 1
     FOR UPDATE;

    EXIT WHEN v_credit IS NULL;
    -- A selected credit may expire while its row lock is awaited. Recheck
    -- at consumption, then select the next valid pack before charging diamonds.
    UPDATE public.feature_purchases
       SET uses_remaining = uses_remaining - 1
     WHERE id = v_credit
       AND user_id = v_uid
       AND COALESCE(uses_remaining, 0) > 0
       AND (expires_at IS NULL OR expires_at > clock_timestamp())
     RETURNING uses_remaining INTO v_left;
    EXIT WHEN FOUND;
  END LOOP;

  IF v_credit IS NOT NULL THEN

    INSERT INTO public.throw_usage (user_id, throwable_id, paid_diamonds, created_at)
    VALUES (v_uid, p_throwable_id, false, clock_timestamp());

    v_result := jsonb_build_object(
      'success', true,
      'paid', false,
      'source', 'purchased',
      'from_pack', true,
      'credit_source', v_credit_src,
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

  INSERT INTO public.throw_usage (user_id, throwable_id, paid_diamonds, created_at)
  VALUES (v_uid, p_throwable_id, true, clock_timestamp());

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
$function$;

-- ---------------------------------------------------------------------------
-- 2. Rabbit hunts
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_consume_rabbit_hunt_v2(p_user_id uuid, p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_vip_monthly_cap CONSTANT int := 100;
  v_default_cost    CONSTANT int := 5;
  v_is_vip          boolean;
  v_is_lifetime     boolean;
  v_month           text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_used            int;
  v_cost            int;
  v_row             record;
  v_deduct          jsonb;
  v_balance         integer;
  v_request_payload jsonb := jsonb_build_object(
    'feature', 'rabbit_hunt',
    'user_id', p_user_id
  );
  v_cached_kind     text;
  v_cached_payload  jsonb;
  v_cached_result   jsonb;
  v_result          jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'fn_consume_rabbit_hunt_v2 is engine-only';
  END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'User Id Required');
  END IF;
  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Secure Request Id Required');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'digital_purchase_request:' || p_user_id::text || ':' || p_request_id::text,
      0
    )
  );

  SELECT r.purchase_kind, r.request_payload, r.result
    INTO v_cached_kind, v_cached_payload, v_cached_result
    FROM public.digital_purchase_receipts r
   WHERE r.user_id = p_user_id
     AND r.request_id = p_request_id;

  IF FOUND THEN
    IF v_cached_kind IS DISTINCT FROM 'rabbit_hunt'
       OR v_cached_payload IS DISTINCT FROM v_request_payload
    THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Request Id Already Used For Another Purchase',
        'code', 'REQUEST_ID_REUSED'
      );
    END IF;

    RETURN v_cached_result || jsonb_build_object(
      'diamonds_spent', 0,
      'original_diamonds_spent',
        COALESCE(
          (v_cached_result->>'original_diamonds_spent')::integer,
          (v_cached_result->>'diamonds_spent')::integer,
          0
        ),
      'idempotent', true,
      'consumed', false
    );
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('rabbit_hunt:' || p_user_id::text, 0));

  SELECT
    COALESCE(p.is_vip, false)
      AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now()),
    COALESCE(p.is_vip, false) AND p.vip_tier = 'lifetime'
    INTO v_is_vip, v_is_lifetime
    FROM public.profiles p
   WHERE p.id = p_user_id;

  IF v_is_vip IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown user');
  END IF;

  IF v_is_lifetime THEN
    INSERT INTO public.vip_feature_usage_monthly
      (user_id, feature, month, usage_count, updated_at)
    VALUES
      (p_user_id, 'rabbit_hunt', v_month, 1, now())
    ON CONFLICT (user_id, feature, month) DO UPDATE
       SET usage_count = public.vip_feature_usage_monthly.usage_count + 1,
           updated_at = now();

    v_result := jsonb_build_object(
      'success', true,
      'source', 'lifetime_vip',
      'unlimited', true,
      'vip_remaining', null,
      'diamonds_spent', 0,
      'idempotent', false,
      'consumed', true
    );
    INSERT INTO public.digital_purchase_receipts
      (user_id, request_id, purchase_kind, request_payload, result)
    VALUES
      (p_user_id, p_request_id, 'rabbit_hunt', v_request_payload, v_result);
    RETURN v_result;
  END IF;

  -- AN EXPIRING CREDIT IS SPENT BEFORE AN ALLOWANCE THAT RENEWS. A daily
  -- bonus credit lives seven days; the VIP allowance comes back on the
  -- first. Soonest to expire first.
  SELECT id, uses_remaining, source INTO v_row
    FROM public.feature_purchases
   WHERE user_id = p_user_id
     AND feature = 'rabbit_hunt'
     AND COALESCE(uses_remaining, 0) > 0
     AND expires_at IS NOT NULL
     AND expires_at > now()
   ORDER BY expires_at ASC, created_at ASC
   FOR UPDATE
   LIMIT 1;

  IF FOUND THEN
    UPDATE public.feature_purchases
       SET uses_remaining = uses_remaining - 1
     WHERE id = v_row.id;

    v_result := jsonb_build_object(
      'success', true,
      'source', 'purchased',
      'expiring', true,
      'credit_source', v_row.source,
      'uses_remaining', v_row.uses_remaining - 1,
      'diamonds_spent', 0,
      'idempotent', false,
      'consumed', true
    );
    INSERT INTO public.digital_purchase_receipts
      (user_id, request_id, purchase_kind, request_payload, result)
    VALUES
      (p_user_id, p_request_id, 'rabbit_hunt', v_request_payload, v_result);
    RETURN v_result;
  END IF;

  IF v_is_vip THEN
    SELECT COALESCE(SUM(usage_count), 0)::int INTO v_used
      FROM public.vip_feature_usage_monthly
     WHERE user_id = p_user_id
       AND feature = 'rabbit_hunt'
       AND month = v_month;

    IF v_used < v_vip_monthly_cap THEN
      INSERT INTO public.vip_feature_usage_monthly
        (user_id, feature, month, usage_count, updated_at)
      VALUES
        (p_user_id, 'rabbit_hunt', v_month, 1, now())
      ON CONFLICT (user_id, feature, month) DO UPDATE
         SET usage_count = public.vip_feature_usage_monthly.usage_count + 1,
             updated_at = now();

      v_result := jsonb_build_object(
        'success', true,
        'source', 'vip_monthly',
        'vip_used', v_used + 1,
        'vip_remaining', v_vip_monthly_cap - (v_used + 1),
        'diamonds_spent', 0,
        'idempotent', false,
        'consumed', true
      );
      INSERT INTO public.digital_purchase_receipts
        (user_id, request_id, purchase_kind, request_payload, result)
      VALUES
        (p_user_id, p_request_id, 'rabbit_hunt', v_request_payload, v_result);
      RETURN v_result;
    END IF;
  END IF;

  SELECT id, uses_remaining, source INTO v_row
    FROM public.feature_purchases
   WHERE user_id = p_user_id
     AND feature = 'rabbit_hunt'
     AND COALESCE(uses_remaining, 0) > 0
     AND (expires_at IS NULL OR expires_at > now())
   ORDER BY created_at
   FOR UPDATE
   LIMIT 1;

  IF FOUND THEN
    UPDATE public.feature_purchases
       SET uses_remaining = uses_remaining - 1
     WHERE id = v_row.id;

    v_result := jsonb_build_object(
      'success', true,
      'source', 'purchased',
      'credit_source', v_row.source,
      'uses_remaining', v_row.uses_remaining - 1,
      'diamonds_spent', 0,
      'idempotent', false,
      'consumed', true
    );
    INSERT INTO public.digital_purchase_receipts
      (user_id, request_id, purchase_kind, request_payload, result)
    VALUES
      (p_user_id, p_request_id, 'rabbit_hunt', v_request_payload, v_result);
    RETURN v_result;
  END IF;

  SELECT COALESCE(diamond_cost, v_default_cost) INTO v_cost
    FROM public.feature_pricing
   WHERE feature = 'rabbit_hunt'
   LIMIT 1;
  v_cost := COALESCE(v_cost, v_default_cost);

  IF v_cost < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rabbit Hunt Pricing Is Invalid');
  END IF;

  IF v_cost > 0 THEN
    v_deduct := public.deduct_diamonds(
      p_user_id          => p_user_id,
      p_amount           => v_cost,
      p_description      => 'Rabbit Hunt',
      p_transaction_type => 'feature_purchase',
      p_source           => 'rabbit_hunt',
      p_reference_id     => 'rabbit_use_' || p_user_id::text || '_' || p_request_id::text
    );

    IF COALESCE((v_deduct->>'success')::boolean, false) IS NOT TRUE THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_diamonds',
        'cost', v_cost,
        'diamonds_remaining', (v_deduct->>'balance')::numeric
      );
    END IF;

    IF COALESCE((v_deduct->>'idempotent')::boolean, false) THEN
      v_result := jsonb_build_object(
        'success', true,
        'source', 'diamonds',
        'diamonds_spent', 0,
        'original_diamonds_spent', v_cost,
        'diamonds_remaining', (v_deduct->>'balance')::numeric,
        'idempotent', true,
        'consumed', false
      );
      INSERT INTO public.digital_purchase_receipts
        (user_id, request_id, purchase_kind, request_payload, result)
      VALUES
        (p_user_id, p_request_id, 'rabbit_hunt', v_request_payload, v_result);
      RETURN v_result;
    END IF;
    v_balance := (v_deduct->>'balance')::integer;
  ELSE
    SELECT p.diamonds INTO v_balance
      FROM public.profiles p
     WHERE p.id = p_user_id;
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'source', 'diamonds',
    'diamonds_spent', v_cost,
    'diamonds_remaining', v_balance,
    'idempotent', false,
    'consumed', true
  );
  INSERT INTO public.digital_purchase_receipts
    (user_id, request_id, purchase_kind, request_payload, result)
  VALUES
    (p_user_id, p_request_id, 'rabbit_hunt', v_request_payload, v_result);
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Time bank
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_consume_time_bank(p_user_id uuid, p_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_vip      boolean;
  v_is_lifetime boolean;
  v_month       text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_used        int;
  v_from_vip    int := 0;
  v_remaining   int;
  v_uses_needed int;
  v_uses_taken  int := 0;
  v_expiring_taken int := 0;
  v_row         record;
  v_take        int;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'fn_consume_time_bank is engine-only';
  END IF;
  IF p_seconds IS NULL OR p_seconds <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_seconds must be positive');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('time_bank:' || p_user_id::text, 0));

  SELECT
    COALESCE(p.is_vip, false)
      AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now()),
    COALESCE(p.is_vip, false) AND p.vip_tier = 'lifetime'
    INTO v_is_vip, v_is_lifetime
    FROM public.profiles p
   WHERE p.id = p_user_id;

  IF v_is_vip IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown user');
  END IF;

  IF v_is_lifetime THEN
    INSERT INTO public.vip_feature_usage_monthly
      (user_id, feature, month, usage_count, updated_at)
    VALUES
      (p_user_id, 'time_bank_seconds', v_month, p_seconds, now())
    ON CONFLICT (user_id, feature, month) DO UPDATE
       SET usage_count = public.vip_feature_usage_monthly.usage_count + EXCLUDED.usage_count,
           updated_at = now();

    RETURN jsonb_build_object(
      'success', true,
      'source', 'lifetime_vip',
      'unlimited', true,
      'consumed_vip_seconds', p_seconds,
      'consumed_purchased_uses', 0,
      'shortfall_seconds', 0
    );
  END IF;

  v_remaining := p_seconds;

  -- AN EXPIRING CREDIT IS SPENT BEFORE AN ALLOWANCE THAT RENEWS. A daily
  -- bonus credit lives seven days; the VIP allowance comes back on the
  -- first. One use is twenty seconds; soonest to expire first.
  v_uses_needed := CEIL(v_remaining / 20.0)::int;
  FOR v_row IN
    SELECT id, uses_remaining
      FROM public.feature_purchases
     WHERE user_id = p_user_id
       AND feature = 'time_bank_seconds'
       AND COALESCE(uses_remaining, 0) > 0
       AND expires_at IS NOT NULL
       AND expires_at > now()
     ORDER BY expires_at ASC, created_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_uses_needed <= 0;
    v_take := LEAST(v_row.uses_remaining, v_uses_needed);
    UPDATE public.feature_purchases
       SET uses_remaining = uses_remaining - v_take
     WHERE id = v_row.id;
    v_uses_taken := v_uses_taken + v_take;
    v_expiring_taken := v_expiring_taken + v_take;
    v_uses_needed := v_uses_needed - v_take;
  END LOOP;
  v_remaining := GREATEST(0, v_remaining - v_expiring_taken * 20);

  IF v_remaining > 0 AND v_is_vip THEN
    SELECT COALESCE(SUM(usage_count), 0)::int INTO v_used
      FROM public.vip_feature_usage_monthly
     WHERE user_id = p_user_id
       AND feature = 'time_bank_seconds'
       AND month = v_month;

    v_from_vip := LEAST(v_remaining, GREATEST(0, 120 - v_used));
    IF v_from_vip > 0 THEN
      INSERT INTO public.vip_feature_usage_monthly
        (user_id, feature, month, usage_count, updated_at)
      VALUES
        (p_user_id, 'time_bank_seconds', v_month, v_from_vip, now())
      ON CONFLICT (user_id, feature, month) DO UPDATE
         SET usage_count = public.vip_feature_usage_monthly.usage_count + EXCLUDED.usage_count,
             updated_at = now();
      v_remaining := v_remaining - v_from_vip;
    END IF;
  END IF;

  IF v_remaining > 0 THEN
    v_uses_needed := CEIL(v_remaining / 20.0)::int;
    FOR v_row IN
      SELECT id, uses_remaining
        FROM public.feature_purchases
       WHERE user_id = p_user_id
         AND feature = 'time_bank_seconds'
         AND COALESCE(uses_remaining, 0) > 0
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY created_at
       FOR UPDATE
    LOOP
      EXIT WHEN v_uses_needed <= 0;
      v_take := LEAST(v_row.uses_remaining, v_uses_needed);
      UPDATE public.feature_purchases
         SET uses_remaining = uses_remaining - v_take
       WHERE id = v_row.id;
      v_uses_taken := v_uses_taken + v_take;
      v_uses_needed := v_uses_needed - v_take;
    END LOOP;
    v_remaining := GREATEST(0, v_remaining - (v_uses_taken - v_expiring_taken) * 20);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'consumed_vip_seconds', v_from_vip,
    'consumed_purchased_uses', v_uses_taken,
    'consumed_expiring_uses', v_expiring_taken,
    'shortfall_seconds', v_remaining
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- Assertions: the draw order is expiring credit -> allowance -> pack -> diamonds
-- in every consumer, and the lifetime branch still comes first.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_body text;
BEGIN
  SELECT prosrc INTO v_body FROM pg_proc WHERE proname = 'fn_use_throwable_v2';
  IF position('expires_at IS NOT NULL' IN v_body) = 0
     OR position('expires_at IS NOT NULL' IN v_body) > position('member_monthly' IN v_body)
     OR position('IF v_lifetime THEN' IN v_body) > position('expires_at IS NOT NULL' IN v_body) THEN
    RAISE EXCEPTION 'fn_use_throwable_v2 does not draw an expiring credit between lifetime and the allowance';
  END IF;

  SELECT prosrc INTO v_body FROM pg_proc WHERE proname = 'fn_consume_rabbit_hunt_v2';
  IF position('expires_at IS NOT NULL' IN v_body) = 0
     OR position('expires_at IS NOT NULL' IN v_body) > position('v_used < v_vip_monthly_cap' IN v_body)
     OR position('IF v_is_lifetime THEN' IN v_body) > position('expires_at IS NOT NULL' IN v_body) THEN
    RAISE EXCEPTION 'fn_consume_rabbit_hunt_v2 does not draw an expiring credit between lifetime and the allowance';
  END IF;

  SELECT prosrc INTO v_body FROM pg_proc WHERE proname = 'fn_consume_time_bank';
  IF position('expires_at IS NOT NULL' IN v_body) = 0
     OR position('expires_at IS NOT NULL' IN v_body) > position('120 - v_used' IN v_body)
     OR position('IF v_is_lifetime THEN' IN v_body) > position('expires_at IS NOT NULL' IN v_body) THEN
    RAISE EXCEPTION 'fn_consume_time_bank does not draw an expiring credit between lifetime and the allowance';
  END IF;

  IF (SELECT public.fn_ca_mint_supply('diamonds'))
     <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float() THEN
    RAISE EXCEPTION 'players + float <> register after a change that moves no money';
  END IF;
END $$;

COMMIT;
