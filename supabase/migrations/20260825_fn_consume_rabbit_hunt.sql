-- ═══════════════════════════════════════════════════════════════════════════
-- RABBIT HUNT IS PAID FOR ON THE SERVER, OR IT IS NOT PAID FOR AT ALL
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan 2026-08-25: "VIP members get 100 rabbit hunts a month for free, and they
-- cost 5 diamonds each after that."
--
-- Until now the entire paywall was client-side: the engine broadcast the five
-- remaining cards to EVERY socket at the table the moment a hand ended, and
-- RabbitHunt.tsx decided on its own whether to bill. Anyone with devtools read
-- the cards off the websocket for free, and the billing call it did make went
-- to fn_purchase_feature relying on a cost that defaults to 0 — so even the
-- honest path charged nothing.
--
-- This is the charge, and it is engine-only. The cards are handed out by the
-- game server only after this returns success, one player at a time.
--
-- Modelled directly on fn_consume_time_bank (20260818_time_bank_20s_per_use):
-- same engine-only guard, same advisory lock against double-spend, same
-- VIP-pool-then-purchases waterfall. The one difference is the tail: a time
-- bank reports a shortfall and lets the hand continue, because refusing it
-- mid-hand would be worse than comping it. A rabbit hunt is a purchase with no
-- hand riding on it, so a shortfall is a refusal.
--
-- WATERFALL
--   1. VIP monthly pool  — 100/month, vip_feature_usage_monthly
--   2. Purchased packs   — feature_purchases FIFO (this is what makes the
--                          promo_vault 'rabbit_hunt_100' pack mean something)
--   3. Diamonds          — feature_pricing.diamond_cost, default 5
--
-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.fn_consume_rabbit_hunt(uuid);
--   (Tier 2: creates one new function, alters no table and no existing
--    function. Dropping it restores the previous state exactly. The engine
--    treats a missing function as "charge failed" and shows no cards.)

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
  -- A player's own JWT must never reach this: it is the whole point.
  IF COALESCE(auth.role(),'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'fn_consume_rabbit_hunt is engine-only';
  END IF;

  -- One charge at a time per user. Without this, two tables finishing a hand
  -- in the same millisecond both read the same usage_count and both take the
  -- 100th free hunt.
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

  -- 2) Purchased packs, oldest first, so a pack bought earlier is spent first
  --    and an expiring one is not stranded behind a fresh purchase.
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

  -- 3) Diamonds. Price is data, not a literal, so it can be repriced without a
  --    deploy; the constant is only the fallback if the row is missing.
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
      -- ->> yields TEXT, so this used to serialise as "42" rather than 42 while
      -- the API type promised a number. ::numeric makes the wire format match.
      'diamonds_remaining', (v_deduct->>'balance')::numeric
    );
  END IF;

  -- No pool, no pack, not enough diamonds. Nothing is revealed.
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

-- Price row. ON CONFLICT so re-running is a no-op and so a later repricing in
-- the dashboard is not stamped back over by a replay of this migration.
INSERT INTO feature_pricing (feature, diamond_cost, usage_type, description)
VALUES ('rabbit_hunt', 5, 'per_use', 'See the cards that would have come')
ON CONFLICT (feature) DO NOTHING;

-- ── POST-APPLY ASSERTIONS (house style: the migration proves its own claims) ──
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_consume_rabbit_hunt'
  ) THEN
    RAISE EXCEPTION 'fn_consume_rabbit_hunt was not created';
  END IF;

  -- The engine-only guard is the security boundary. If a future edit drops it,
  -- any authenticated player could mint themselves free rabbit hunts.
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
