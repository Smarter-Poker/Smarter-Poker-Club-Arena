-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825191250; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- COSMETIC PURCHASE INTEGRITY 2026-08-25. See
-- supabase/migrations/20260825_feature_pricing_integrity.sql in club-arena for
-- the full rationale and the ROLLBACK section.

-- 1. auto_time_bank was priced in the UI ("5 D") and sold nowhere.
INSERT INTO public.feature_pricing (feature, diamond_cost, usage_type, description)
VALUES ('auto_time_bank', 5, 'per_use', 'Auto time bank (diamonds per activation)')
ON CONFLICT (feature) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_pricing WHERE feature = 'auto_time_bank') THEN
    RAISE EXCEPTION 'auto_time_bank still has no price row';
  END IF;
END $$;

-- 2. A permanent / live per-session feature cannot be sold twice.
CREATE OR REPLACE FUNCTION public.fn_purchase_feature(
  p_user_id uuid,
  p_feature text,
  p_cost integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_price record;
  v_deduct jsonb;
  v_expires timestamptz;
  v_uses integer;
BEGIN
  IF v_caller IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'authentication required'); END IF;
  IF p_user_id IS DISTINCT FROM v_caller THEN
    RETURN jsonb_build_object('success', false, 'error', 'can only purchase for your own account');
  END IF;

  -- Server-side pricing - the client-supplied p_cost is IGNORED by design.
  SELECT feature, diamond_cost, usage_type INTO v_price
    FROM feature_pricing WHERE feature = p_feature;
  IF v_price.feature IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown feature: ' || p_feature);
  END IF;

  -- Serialize this buyer against this feature: the ownership test below is a
  -- read followed by a write, and without the lock two concurrent Buy clicks
  -- both read "not owned" and both charge.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('fn_purchase_feature:' || v_caller::text || ':' || p_feature, 0)
  );

  IF v_price.usage_type IN ('permanent', 'per_session') THEN
    IF EXISTS (
      SELECT 1 FROM feature_purchases
       WHERE user_id = v_caller
         AND feature = p_feature
         AND (expires_at IS NULL OR expires_at > now())
    ) THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'already_owned',
        'already_owned', true,
        'usage_type', v_price.usage_type
      );
    END IF;
  END IF;

  IF v_price.diamond_cost > 0 THEN
    v_deduct := deduct_diamonds(
      p_user_id        := v_caller,
      p_amount         := v_price.diamond_cost,
      p_description    := 'Feature purchase: ' || p_feature,
      p_transaction_type := 'feature_purchase',
      p_source         := 'feature_purchase',
      p_metadata       := jsonb_build_object('feature', p_feature),
      p_reference_id   := 'feat_' || p_feature || '_' || v_caller || '_' || extract(epoch from date_trunc('second', now()))::text
    );
    IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
      RETURN jsonb_build_object('success', false, 'error', COALESCE(v_deduct->>'error', 'diamond charge failed'));
    END IF;
  END IF;

  v_uses := CASE v_price.usage_type WHEN 'per_use' THEN 1 ELSE NULL END;
  v_expires := CASE v_price.usage_type WHEN 'per_session' THEN now() + interval '8 hours' ELSE NULL END;

  INSERT INTO feature_purchases (user_id, feature, cost, usage_type, uses_remaining, expires_at)
  VALUES (v_caller, p_feature, v_price.diamond_cost, v_price.usage_type, v_uses, v_expires);

  RETURN jsonb_build_object('success', true, 'cost', v_price.diamond_cost, 'usage_type', v_price.usage_type);
END;
$function$;

-- 3. The price table is not writable by the people paying the prices.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.feature_pricing FROM anon, authenticated;

-- Post-apply assertions.
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_purchase_feature';

  IF v_src IS NULL OR position('already_owned' in v_src) = 0 THEN
    RAISE EXCEPTION 'fn_purchase_feature has no already_owned guard after apply';
  END IF;
  IF position('pg_advisory_xact_lock' in v_src) = 0 THEN
    RAISE EXCEPTION 'fn_purchase_feature has no advisory lock after apply';
  END IF;
  IF has_table_privilege('authenticated', 'public.feature_pricing', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated can still UPDATE feature_pricing';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.feature_pricing', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated lost SELECT on feature_pricing';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fn_purchase_feature(uuid, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated lost EXECUTE on fn_purchase_feature';
  END IF;
END $$;
