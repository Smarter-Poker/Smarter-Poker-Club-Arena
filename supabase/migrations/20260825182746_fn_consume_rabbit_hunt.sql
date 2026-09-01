-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825182746; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_consume_rabbit_hunt(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_vip_monthly_cap CONSTANT int := 100;   -- Dan 2026-08-25
  v_default_cost    CONSTANT int := 5;     -- diamonds, Dan 2026-08-25
  v_is_vip  boolean;
  v_month   text := to_char(now() AT TIME ZONE 'UTC','YYYY-MM');
  v_used    int;
  v_cost    int;
  v_row     record;
  v_deduct  jsonb;
BEGIN
  -- Engine-only writer. auth.role() is 'service_role' when called with the
  -- service key; migrations/admin run with no claims (NULL) and are allowed.
  IF COALESCE(auth.role(),'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'fn_consume_rabbit_hunt is engine-only';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('rabbit_hunt:' || p_user_id::text, 0));

  SELECT (COALESCE(p.is_vip,false) AND (p.vip_expires_at IS NULL OR p.vip_expires_at > now()))
    INTO v_is_vip FROM profiles p WHERE p.id = p_user_id;
  IF v_is_vip IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown user');
  END IF;

  -- 1) VIP monthly pool. The "reset" is implicit: a new month is a new key.
  IF v_is_vip THEN
    SELECT COALESCE(SUM(usage_count),0)::int INTO v_used
    FROM vip_feature_usage_monthly
    WHERE user_id = p_user_id AND feature = 'rabbit_hunt' AND month = v_month;

    IF v_used < v_vip_monthly_cap THEN
      INSERT INTO vip_feature_usage_monthly (user_id, feature, month, usage_count, updated_at)
      VALUES (p_user_id, 'rabbit_hunt', v_month, 1, now())
      ON CONFLICT (user_id, feature, month) DO UPDATE
         SET usage_count = vip_feature_usage_monthly.usage_count + 1,
             updated_at = now();
      RETURN jsonb_build_object(
        'success', true,
        'source', 'vip_monthly',
        'vip_used', v_used + 1,
        'vip_remaining', v_vip_monthly_cap - (v_used + 1),
        'diamonds_spent', 0
      );
    END IF;
  END IF;

  -- 2) Purchased packs, oldest first.
  SELECT id, uses_remaining INTO v_row
  FROM feature_purchases
  WHERE user_id = p_user_id AND feature = 'rabbit_hunt'
    AND COALESCE(uses_remaining,0) > 0
    AND (expires_at IS NULL OR expires_at > now())
  ORDER BY created_at
  FOR UPDATE
  LIMIT 1;

  IF FOUND THEN
    UPDATE feature_purchases SET uses_remaining = uses_remaining - 1 WHERE id = v_row.id;
    RETURN jsonb_build_object(
      'success', true,
      'source', 'purchased',
      'uses_remaining', v_row.uses_remaining - 1,
      'diamonds_spent', 0
    );
  END IF;

  -- 3) Diamonds. Price is data, not a literal.
  SELECT COALESCE(diamond_cost, v_default_cost) INTO v_cost
  FROM feature_pricing WHERE feature = 'rabbit_hunt' LIMIT 1;
  v_cost := COALESCE(v_cost, v_default_cost);

  v_deduct := deduct_diamonds(
    p_user_id          => p_user_id,
    p_amount           => v_cost,
    p_description      => 'Rabbit Hunt',
    p_transaction_type => 'feature_purchase',
    p_source           => 'rabbit_hunt'
  );

  IF COALESCE((v_deduct->>'success')::boolean, false) THEN
    RETURN jsonb_build_object(
      'success', true,
      'source', 'diamonds',
      'diamonds_spent', v_cost,
      'diamonds_remaining', (v_deduct->>'balance')
    );
  END IF;

  RETURN jsonb_build_object(
    'success', false,
    'error', 'insufficient_diamonds',
    'cost', v_cost,
    'diamonds_remaining', (v_deduct->>'balance')
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_consume_rabbit_hunt(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_consume_rabbit_hunt(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_consume_rabbit_hunt(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_consume_rabbit_hunt(uuid) TO service_role;

INSERT INTO feature_pricing (feature, diamond_cost, usage_type, description)
VALUES ('rabbit_hunt', 5, 'per_use', 'See the cards that would have come')
ON CONFLICT (feature) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_consume_rabbit_hunt'
  ) THEN
    RAISE EXCEPTION 'fn_consume_rabbit_hunt was not created';
  END IF;

  IF pg_get_functiondef((
        SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname='fn_consume_rabbit_hunt'
     )) NOT LIKE '%is engine-only%' THEN
    RAISE EXCEPTION 'fn_consume_rabbit_hunt lost its engine-only guard';
  END IF;

  IF has_function_privilege('authenticated', 'public.fn_consume_rabbit_hunt(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_consume_rabbit_hunt must not be executable by authenticated';
  END IF;

  IF NOT has_function_privilege('service_role', 'public.fn_consume_rabbit_hunt(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute fn_consume_rabbit_hunt';
  END IF;
END $$;
