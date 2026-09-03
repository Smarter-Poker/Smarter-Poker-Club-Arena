-- TABLE STUDIO PURCHASES MUST SELL NEW PERMISSION, NOT A SECOND RECEIPT.
--
-- `fn_purchase_feature` previously rejected only an existing row for the exact
-- feature id. Complete theme purchases also grant their linked felt, controls,
-- background and card-back rows in `theme_asset_unlocks`. A direct or stale
-- client could buy one of those linked SKUs afterwards and pay for permission
-- it already held. Two concurrent purchases of a preset and one of its linked
-- assets also used different advisory locks, so both could pass their read
-- before either grant became visible.
--
-- All permanent Table Studio/card-back purchases now serialize on one
-- account-scoped customization lock and consult the canonical entitlement
-- predicate before any diamond debit. Other feature families retain the
-- narrower per-feature lock and their existing stackability semantics.

BEGIN;

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
  v_category text;
  v_asset_id text;
  v_is_customization boolean := false;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication required');
  END IF;
  IF p_user_id IS DISTINCT FROM v_caller THEN
    RETURN jsonb_build_object('success', false, 'error', 'can only purchase for your own account');
  END IF;

  -- Server-side pricing. The client-supplied p_cost is ignored by design.
  SELECT feature, diamond_cost, usage_type INTO v_price
    FROM public.feature_pricing WHERE feature = p_feature;
  IF v_price.feature IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown feature: ' || p_feature);
  END IF;

  IF p_feature LIKE 'studio:%' THEN
    v_category := split_part(p_feature, ':', 2);
    v_asset_id := substring(p_feature from length('studio:' || v_category || ':') + 1);
    v_is_customization := v_category IN (
      'theme_id', 'table_id', 'button_id', 'background_id'
    ) AND COALESCE(v_asset_id, '') <> '';
  ELSIF p_feature LIKE 'card_back_%' THEN
    v_category := 'cards_id';
    v_asset_id := substring(p_feature from length('card_back_') + 1);
    v_is_customization := COALESCE(v_asset_id, '') <> '';
  END IF;

  -- Presets and their linked assets overlap. One account-scoped lock makes a
  -- preset-vs-asset race observe the grant committed by whichever purchase won
  -- the lock. Unrelated feature families keep their existing narrow lock.
  IF v_is_customization AND v_price.usage_type = 'permanent' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('fn_purchase_feature:customization:' || v_caller::text, 0)
    );
  ELSE
    PERFORM pg_advisory_xact_lock(
      hashtextextended('fn_purchase_feature:' || v_caller::text || ':' || p_feature, 0)
    );
  END IF;

  IF v_price.usage_type IN ('permanent', 'per_session') THEN
    IF EXISTS (
      SELECT 1 FROM public.feature_purchases
       WHERE user_id = v_caller
         AND feature = p_feature
         AND (expires_at IS NULL OR expires_at > now())
    ) THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'already_owned',
        'already_owned', true,
        'usage_type', v_price.usage_type,
        'ownership_source', 'purchase_receipt'
      );
    END IF;

    IF v_is_customization
       AND public.sp_theme_asset_is_owned(v_caller, v_category, v_asset_id)
    THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'already_owned',
        'already_owned', true,
        'usage_type', v_price.usage_type,
        'ownership_source', 'entitlement'
      );
    END IF;
  END IF;

  IF v_price.diamond_cost > 0 THEN
    v_deduct := public.deduct_diamonds(
      p_user_id          := v_caller,
      p_amount           := v_price.diamond_cost,
      p_description      := 'Feature purchase: ' || p_feature,
      p_transaction_type := 'feature_purchase',
      p_source           := 'feature_purchase',
      p_metadata         := jsonb_build_object('feature', p_feature),
      p_reference_id     := 'feat_' || p_feature || '_' || v_caller || '_' ||
                            extract(epoch from date_trunc('second', now()))::text
    );
    IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', COALESCE(v_deduct->>'error', 'diamond charge failed')
      );
    END IF;
  END IF;

  v_uses := CASE v_price.usage_type WHEN 'per_use' THEN 1 ELSE NULL END;
  v_expires := CASE v_price.usage_type
    WHEN 'per_session' THEN now() + interval '8 hours'
    ELSE NULL
  END;

  INSERT INTO public.feature_purchases
    (user_id, feature, cost, usage_type, uses_remaining, expires_at)
  VALUES
    (v_caller, p_feature, v_price.diamond_cost, v_price.usage_type, v_uses, v_expires);

  RETURN jsonb_build_object(
    'success', true,
    'cost', v_price.diamond_cost,
    'usage_type', v_price.usage_type
  );
END;
$function$;

DO $$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_purchase_feature';

  IF v_src IS NULL
     OR position('fn_purchase_feature:customization:' in v_src) = 0
     OR position('sp_theme_asset_is_owned' in v_src) = 0
     OR position('ownership_source' in v_src) = 0
  THEN
    RAISE EXCEPTION 'fn_purchase_feature is missing the entitlement-aware customization guard';
  END IF;

  IF NOT has_function_privilege(
    'authenticated',
    'public.fn_purchase_feature(uuid, text, integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated lost purchase permission';
  END IF;
END $$;

COMMIT;
