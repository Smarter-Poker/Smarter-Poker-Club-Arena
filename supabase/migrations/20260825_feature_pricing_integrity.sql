-- ═══════════════════════════════════════════════════════════════════════════════
--  COSMETIC PURCHASE INTEGRITY — 2026-08-25
--
--  Found by the cosmetics purchase/ownership audit. Three defects, all on the
--  path a player uses to buy a cosmetic with diamonds.
--
--  1. `auto_time_bank` was PRICED IN THE UI AND SOLD NOWHERE.
--     src/components/table/TableSettings.tsx prints "5 per use" and "5 D" for
--     it, and fn_purchase_feature answered `unknown feature: auto_time_bank`
--     because `feature_pricing` had no row. A price on screen for something
--     the server refuses to sell. The advertised price is honoured here rather
--     than the product being quietly withdrawn: 5 diamonds per use, the same
--     as `time_bank_seconds`, which is the manual version of the same thing.
--
--  2. fn_purchase_feature COULD CHARGE TWICE FOR A THING YOU ALREADY OWN.
--     For `permanent` features (theme_unlock 25, club_creation 100, and the
--     eight card_back_* cosmetics at 50-300 diamonds) and for a live
--     `per_session` feature, the function charged and inserted unconditionally.
--     The only guard was VIPService.checkExistingPurchase running in the
--     BROWSER before the call — a read-then-write race, and one the player can
--     lose by simply clicking Buy twice.
--
--     deduct_diamonds() does dedupe on reference_id, but fn_purchase_feature
--     builds that id from `date_trunc('second', now())`, so the protection is
--     a ONE-SECOND window. Two clicks 1.1 seconds apart were two debits and
--     two rows. Measured shape confirmed in prod: user 47965354 holds two
--     `theme_unlock` permanent rows 3.3s apart.
--
--     The fix refuses the second purchase as `already_owned` BEFORE any charge,
--     under a transaction-scoped advisory lock keyed on (user, feature) so the
--     check and the insert cannot be interleaved by a concurrent session. A
--     bare `SELECT ... FOR UPDATE` would not do: there is no row to lock in the
--     race that matters.
--
--     `per_use` stays stackable — buying a second throw is a real purchase.
--
--  3. `feature_pricing` GRANTED INSERT/UPDATE/DELETE TO anon AND authenticated.
--     RLS is on and only a SELECT policy exists, so the writes are refused
--     today. But this is the table that decides what every cosmetic costs, and
--     it should not be one `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` away
--     from being buyer-editable. The grants are removed.
--
--  ROLLBACK
--  --------
--    DELETE FROM feature_pricing WHERE feature = 'auto_time_bank';
--    -- restore the pre-guard body (no advisory lock, no already_owned check):
--    -- see git history for fn_purchase_feature as of 2026-08-24.
--    GRANT INSERT, UPDATE, DELETE ON public.feature_pricing TO anon, authenticated;
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1. The advertised price becomes a real one ────────────────────────────────

INSERT INTO public.feature_pricing (feature, diamond_cost, usage_type, description)
VALUES ('auto_time_bank', 5, 'per_use', 'Auto time bank (diamonds per activation)')
ON CONFLICT (feature) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_pricing WHERE feature = 'auto_time_bank') THEN
    RAISE EXCEPTION 'auto_time_bank still has no price row; the UI would keep advertising a product the RPC refuses';
  END IF;
END $$;

-- ── 2. A feature you already hold cannot be sold to you again ─────────────────

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

  -- Server-side pricing — the client-supplied p_cost is IGNORED by design.
  SELECT feature, diamond_cost, usage_type INTO v_price
    FROM feature_pricing WHERE feature = p_feature;
  IF v_price.feature IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown feature: ' || p_feature);
  END IF;

  -- SERIALIZE THIS BUYER AGAINST THIS FEATURE. The ownership test below is a
  -- read followed by a write; without the lock two concurrent Buy clicks both
  -- read "not owned" and both charge. Transaction-scoped, so it is released
  -- whether this function commits or raises.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('fn_purchase_feature:' || v_caller::text || ':' || p_feature, 0)
  );

  -- Permanent means once. A live per-session entitlement is likewise already
  -- paid for. Refused BEFORE the charge, so a refused purchase costs nothing.
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

-- ── 3. The price table is not writable by the people paying the prices ───────

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.feature_pricing FROM anon, authenticated;

-- ── Post-apply assertions ────────────────────────────────────────────────────

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
    RAISE EXCEPTION 'fn_purchase_feature has no advisory lock after apply; the guard is still racy';
  END IF;

  IF has_table_privilege('authenticated', 'public.feature_pricing', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated can still UPDATE feature_pricing';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.feature_pricing', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated lost SELECT on feature_pricing; the storefront cannot read prices';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fn_purchase_feature(uuid, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated lost EXECUTE on fn_purchase_feature; every cosmetic purchase is now impossible';
  END IF;
END $$;
