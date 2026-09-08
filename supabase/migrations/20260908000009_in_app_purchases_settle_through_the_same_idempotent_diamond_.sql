-- 20260908000009_in_app_purchases_settle_through_the_same_idempotent_diamond_.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (store readiness, phase 3 - Apple 3.1.1 / Play
-- Payments policy, audit tier 0 "Replace external Stripe Checkout with
-- StoreKit and Play Billing"):
--
-- Inside the iOS and Android apps, diamonds and VIP cannot be sold through
-- Stripe Checkout; they must go through the store's own billing. RevenueCat
-- fronts both stores and sends the Hub one webhook per store event. This
-- migration is the database half of that path, and it is built so that an
-- in-app purchase settles through EXACTLY the functions a Stripe purchase
-- settles through - the same idempotent credit, the same purchase lot, the
-- same incident rules - rather than a second money path beside them (10.9:
-- nobody is paid twice; 10.12: no repair job, the live path is atomic).
--
--   iap_products          what each store product id means: which diamond
--                         package, or which VIP tier. Seeded from
--                         diamond_packages; the product ids follow one rule
--                         (poker.smarter.clubarena.<kind>.<key>) that the client
--                         (src/lib/iapProducts.ts) derives too.
--   iap_events            one row per webhook event, keyed by the provider's
--                         event id. A replayed webhook returns its stored
--                         result and touches nothing.
--   diamond_purchases     gains a unique index on metadata->>'iap_transaction_id'
--                         so one store transaction can only ever be one
--                         purchase row, whatever the webhook does.
--   fn_iap_settle_event   the single entry point: service_role only, one
--                         event in, one result out.
--
-- Diamonds: a NON_RENEWING_PURCHASE creates (or finds) the diamond_purchases
-- row for that transaction and calls settle_diamond_card_purchase_atomic
-- with 'iap:<transaction>' where Stripe's session id would go. Everything
-- downstream - add_diamonds_to_balance keyed by purchase id, the lot, DR7/DR8
-- incidents - is untouched and unaware which store paid.
--
-- VIP: INITIAL_PURCHASE / RENEWAL / UNCANCELLATION / PRODUCT_CHANGE apply the
-- same tier and expiry rules the Stripe webhook applies (lifetime is never
-- downgraded, a longer prepaid expiry is never shortened) to profiles, and
-- keep vip_subscriptions in step. CANCELLATION marks cancel_at_period_end
-- (access runs to expiry, as the stores require); EXPIRATION ends it.
--
-- Refunds: a store refund of diamonds is NOT clawed back (10.9 rule 3, and
-- the customer has already been refunded by Apple or Google). It files an
-- incident so a human sees it. Note for whoever reads the Stripe path next:
-- pages/api/store/webhooks/stripe.js calls reconcile_diamond_purchase_refund,
-- which does not exist in this database (checked 2026-09-08).
--
-- Sandbox: a SANDBOX event (TestFlight, internal testing, App Review) settles
-- like a real one - a reviewer buying diamonds must receive diamonds - and is
-- logged as an incident, exactly as a Stripe test-mode session is (DR7).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE TABLE IF NOT EXISTS public.iap_products (
  product_id  text PRIMARY KEY
              CHECK (product_id ~ '^poker\.smarter\.clubarena\.(diamonds|vip)\.[a-z0-9_-]+$'),
  kind        text NOT NULL CHECK (kind IN ('diamonds', 'vip')),
  package_key text REFERENCES public.diamond_packages(package_key),
  vip_tier    text CHECK (vip_tier IN ('monthly', 'yearly')),
  price_usd   numeric(10,2) NOT NULL CHECK (price_usd > 0),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'diamonds' AND package_key IS NOT NULL AND vip_tier IS NULL)
      OR (kind = 'vip' AND vip_tier IS NOT NULL AND package_key IS NULL))
);
COMMENT ON TABLE public.iap_products IS
  'What each App Store / Play Store product id means. Diamonds map to a diamond_packages row; VIP to a tier. Ids follow poker.smarter.clubarena.<kind>.<key>, which src/lib/iapProducts.ts derives identically.';

ALTER TABLE public.iap_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS iap_products_read ON public.iap_products;
CREATE POLICY iap_products_read ON public.iap_products FOR SELECT TO authenticated USING (active);
GRANT SELECT ON public.iap_products TO authenticated;
REVOKE ALL ON public.iap_products FROM anon;

INSERT INTO public.iap_products (product_id, kind, package_key, price_usd, active)
SELECT 'poker.smarter.clubarena.diamonds.' || package_key, 'diamonds', package_key, price_usd, active
  FROM public.diamond_packages
ON CONFLICT (product_id) DO NOTHING;

INSERT INTO public.iap_products (product_id, kind, vip_tier, price_usd) VALUES
  ('poker.smarter.clubarena.vip.monthly', 'vip', 'monthly', 9.99),
  ('poker.smarter.clubarena.vip.yearly',  'vip', 'yearly',  99.99)
ON CONFLICT (product_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.iap_events (
  event_id                text PRIMARY KEY,
  provider                text NOT NULL DEFAULT 'revenuecat',
  event_type              text NOT NULL,
  app_user_id             uuid,
  product_id              text,
  transaction_id          text,
  original_transaction_id text,
  store                   text,
  environment             text,
  received_at             timestamptz NOT NULL DEFAULT now(),
  processed_at            timestamptz,
  result                  jsonb,
  raw                     jsonb NOT NULL
);
COMMENT ON TABLE public.iap_events IS
  'One row per store-billing webhook event (RevenueCat). Keyed by the provider event id so a replay returns its stored result and settles nothing twice.';
CREATE INDEX IF NOT EXISTS iap_events_user_idx ON public.iap_events (app_user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS iap_events_transaction_idx ON public.iap_events (transaction_id);
ALTER TABLE public.iap_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.iap_events FROM anon, authenticated;

-- One store transaction is one purchase row, whatever the webhook does.
CREATE UNIQUE INDEX IF NOT EXISTS diamond_purchases_iap_transaction_uidx
  ON public.diamond_purchases ((metadata ->> 'iap_transaction_id'))
  WHERE metadata ? 'iap_transaction_id';

CREATE OR REPLACE FUNCTION public.fn_iap_settle_event(p_event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_event_id   text := p_event ->> 'id';
  v_type       text := upper(COALESCE(p_event ->> 'type', ''));
  v_user_id    uuid;
  v_product_id text := p_event ->> 'product_id';
  v_txn        text := COALESCE(p_event ->> 'transaction_id', p_event ->> 'id');
  v_orig_txn   text := COALESCE(p_event ->> 'original_transaction_id', p_event ->> 'transaction_id', p_event ->> 'id');
  v_store      text := p_event ->> 'store';
  v_env        text := upper(COALESCE(p_event ->> 'environment', 'PRODUCTION'));
  v_price      numeric;
  v_expires    timestamptz;
  v_period_start timestamptz;
  v_product    public.iap_products%ROWTYPE;
  v_pkg        public.diamond_packages%ROWTYPE;
  v_purchase_id uuid;
  v_settle     jsonb;
  v_result     jsonb;
  v_profile    record;
  v_tier       text;
  v_effective_tier text;
  v_existing_ms bigint;
  v_new_ms     bigint;
  v_rank_existing int;
  v_rank_new   int;
  v_inserted   boolean := false;
BEGIN
  -- Service role only. This is a webhook consumer, never a browser call:
  -- REVOKEd from anon and authenticated below, and asked here as well so a
  -- future grant cannot quietly open it.
  IF COALESCE(auth.role(), current_user) NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'fn_iap_settle_event: service role only (caller %)', COALESCE(auth.role(), current_user)
      USING ERRCODE = '42501';
  END IF;

  IF v_event_id IS NULL OR v_event_id = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing_event_id');
  END IF;

  -- Idempotency: the event id is the key. A replay returns what it returned.
  INSERT INTO public.iap_events (event_id, event_type, app_user_id, product_id, transaction_id,
                                 original_transaction_id, store, environment, raw)
  VALUES (v_event_id, v_type,
          CASE WHEN (p_event ->> 'app_user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               THEN (p_event ->> 'app_user_id')::uuid END,
          v_product_id, v_txn, v_orig_txn, v_store, v_env, p_event)
  ON CONFLICT (event_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF NOT v_inserted THEN
    SELECT COALESCE(result, jsonb_build_object('success', true, 'duplicate', true, 'pending', true))
      INTO v_result FROM public.iap_events WHERE event_id = v_event_id;
    RETURN v_result || jsonb_build_object('duplicate', true);
  END IF;

  SELECT app_user_id INTO v_user_id FROM public.iap_events WHERE event_id = v_event_id;

  -- Events that carry no settlement: recorded, acknowledged, nothing moves.
  IF v_type IN ('TEST', 'TRANSFER', 'SUBSCRIBER_ALIAS', 'SUBSCRIPTION_PAUSED', 'SUBSCRIPTION_EXTENDED', 'TEMPORARY_ENTITLEMENT_GRANT') THEN
    v_result := jsonb_build_object('success', true, 'ignored', true, 'reason', 'no_settlement_for_type', 'type', v_type);
    UPDATE public.iap_events SET processed_at = now(), result = v_result WHERE event_id = v_event_id;
    RETURN v_result;
  END IF;

  IF v_user_id IS NULL THEN
    v_result := jsonb_build_object('success', false, 'error', 'unknown_user', 'app_user_id', p_event ->> 'app_user_id');
    UPDATE public.iap_events SET processed_at = now(), result = v_result WHERE event_id = v_event_id;
    RETURN v_result;
  END IF;

  SELECT * INTO v_product FROM public.iap_products WHERE product_id = v_product_id;
  IF NOT FOUND THEN
    v_result := jsonb_build_object('success', false, 'error', 'unknown_product', 'product_id', v_product_id);
    UPDATE public.iap_events SET processed_at = now(), result = v_result WHERE event_id = v_event_id;
    BEGIN
      PERFORM public.fn_ca_diamond_incident('IAP:unknown_product', 'critical', v_user_id, 0,
        'fn_iap_settle_event', jsonb_build_object('event_id', v_event_id, 'product_id', v_product_id, 'type', v_type));
    EXCEPTION WHEN OTHERS THEN NULL; END;
    RETURN v_result;
  END IF;

  v_price := COALESCE(NULLIF(p_event ->> 'price', '')::numeric, v_product.price_usd);

  -- Sandbox purchases settle (App Review buys diamonds and must receive them)
  -- and are logged, exactly as a Stripe test-mode session is (DR7, log-only).
  IF v_env <> 'PRODUCTION' THEN
    BEGIN
      PERFORM public.fn_ca_diamond_incident('IAP:sandbox_event_settled', 'warning', v_user_id, v_price,
        'fn_iap_settle_event', jsonb_build_object('event_id', v_event_id, 'environment', v_env,
          'product_id', v_product_id, 'type', v_type, 'store', v_store,
          'note', 'Store sandbox event settled into live balances. Log-only, as DR7 is for Stripe test mode.'));
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;

  -- ═══════════════════════ DIAMONDS (consumable) ═══════════════════════
  IF v_product.kind = 'diamonds' THEN
    IF v_type IN ('NON_RENEWING_PURCHASE', 'INITIAL_PURCHASE') THEN
      SELECT * INTO v_pkg FROM public.diamond_packages WHERE package_key = v_product.package_key;
      -- The purchase row for this transaction, created once.
      SELECT id INTO v_purchase_id FROM public.diamond_purchases
       WHERE metadata ->> 'iap_transaction_id' = v_txn;
      IF v_purchase_id IS NULL THEN
        INSERT INTO public.diamond_purchases (user_id, package_name, diamonds_amount, bonus_diamonds,
                                              price_usd, status, metadata)
        VALUES (v_user_id, v_pkg.display_name, v_pkg.diamonds, v_pkg.bonus_diamonds, v_pkg.price_usd, 'pending',
                jsonb_build_object('provider', 'iap', 'iap_transaction_id', v_txn,
                  'iap_original_transaction_id', v_orig_txn, 'iap_store', v_store,
                  'iap_environment', v_env, 'iap_product_id', v_product_id, 'iap_event_id', v_event_id,
                  'store_price', v_price))
        RETURNING id INTO v_purchase_id;
      END IF;
      -- THE SAME SETTLEMENT A CARD PURCHASE GETS. Idempotent on the purchase
      -- id inside; a replay of the transaction returns duplicate:true.
      v_settle := public.settle_diamond_card_purchase_atomic(v_purchase_id, 'iap:' || v_txn, 'iap:' || v_orig_txn);
      v_result := jsonb_build_object('success', COALESCE((v_settle ->> 'success')::boolean, false),
                                     'kind', 'diamonds', 'purchase_id', v_purchase_id, 'settlement', v_settle);
    ELSIF v_type IN ('CANCELLATION', 'REFUND', 'REFUND_REVERSED') THEN
      -- The store has already refunded the customer. Nothing is taken back
      -- (10.9 rule 3); a human is told.
      SELECT id INTO v_purchase_id FROM public.diamond_purchases WHERE metadata ->> 'iap_transaction_id' = v_txn;
      BEGIN
        PERFORM public.fn_ca_diamond_incident('IAP:diamond_refund_received', 'warning', v_user_id, v_price,
          'fn_iap_settle_event', jsonb_build_object('event_id', v_event_id, 'type', v_type,
            'purchase_id', v_purchase_id, 'transaction_id', v_txn, 'store', v_store,
            'note', 'Store refunded a diamond purchase. Diamonds are not clawed back (10.9 rule 3). Review by hand.'));
      EXCEPTION WHEN OTHERS THEN NULL; END;
      IF v_purchase_id IS NOT NULL THEN
        UPDATE public.diamond_purchases
           SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('iap_refund_event_id', v_event_id,
                 'iap_refund_type', v_type, 'iap_refund_at', now()),
               updated_at = now()
         WHERE id = v_purchase_id;
      END IF;
      v_result := jsonb_build_object('success', true, 'kind', 'diamonds', 'refund_noted', true, 'purchase_id', v_purchase_id);
    ELSE
      v_result := jsonb_build_object('success', true, 'ignored', true, 'kind', 'diamonds', 'reason', 'no_settlement_for_type', 'type', v_type);
    END IF;

  -- ═══════════════════════ VIP (auto-renewing) ═══════════════════════
  ELSE
    v_tier := v_product.vip_tier;   -- 'monthly' | 'yearly'
    v_expires := CASE WHEN (p_event ->> 'expiration_at_ms') ~ '^[0-9]+$'
                      THEN to_timestamp((p_event ->> 'expiration_at_ms')::bigint / 1000.0) END;
    v_period_start := CASE WHEN (p_event ->> 'purchased_at_ms') ~ '^[0-9]+$'
                           THEN to_timestamp((p_event ->> 'purchased_at_ms')::bigint / 1000.0) ELSE now() END;

    SELECT id, vip_tier, vip_expires_at, is_vip INTO v_profile FROM public.profiles WHERE id = v_user_id FOR UPDATE;
    IF NOT FOUND THEN
      v_result := jsonb_build_object('success', false, 'error', 'profile_not_found');
      UPDATE public.iap_events SET processed_at = now(), result = v_result WHERE event_id = v_event_id;
      RETURN v_result;
    END IF;

    IF v_type IN ('INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE', 'NON_RENEWING_PURCHASE') THEN
      IF v_expires IS NULL THEN
        v_expires := v_period_start + CASE WHEN v_tier = 'yearly' THEN interval '1 year' ELSE interval '1 month' END;
      END IF;
      -- The Stripe webhook's rules, verbatim in intent: lifetime is never
      -- downgraded; a longer prepaid expiry on a higher tier is never shortened.
      v_existing_ms := CASE WHEN v_profile.vip_expires_at IS NULL THEN 0
                            ELSE (extract(epoch FROM v_profile.vip_expires_at) * 1000)::bigint END;
      v_new_ms := (extract(epoch FROM v_expires) * 1000)::bigint;
      v_rank_existing := CASE v_profile.vip_tier WHEN 'daily' THEN 1 WHEN 'monthly' THEN 2
                              WHEN 'annual' THEN 3 WHEN 'yearly' THEN 3 WHEN 'lifetime' THEN 4 ELSE 0 END;
      v_rank_new := CASE v_tier WHEN 'monthly' THEN 2 WHEN 'yearly' THEN 3 ELSE 0 END;
      IF v_profile.vip_tier = 'lifetime' THEN
        v_effective_tier := 'lifetime';
        UPDATE public.profiles SET is_vip = true, updated_at = now() WHERE id = v_user_id;
      ELSIF v_existing_ms > v_new_ms AND v_rank_existing > v_rank_new THEN
        v_effective_tier := v_profile.vip_tier;
        UPDATE public.profiles SET is_vip = true, updated_at = now() WHERE id = v_user_id;
      ELSE
        v_effective_tier := v_tier;
        UPDATE public.profiles
           SET is_vip = true, vip_tier = v_tier, vip_expires_at = v_expires, updated_at = now()
         WHERE id = v_user_id;
      END IF;

      INSERT INTO public.vip_subscriptions (user_id, stripe_subscription_id, plan, tier, status, price_usd,
                                            current_period_start, current_period_end, cancel_at_period_end, updated_at)
      VALUES (v_user_id, 'iap:' || v_orig_txn, v_tier, v_tier, 'active', v_price,
              v_period_start, v_expires, false, now())
      ON CONFLICT (user_id) DO UPDATE
        SET stripe_subscription_id = EXCLUDED.stripe_subscription_id, plan = EXCLUDED.plan, tier = EXCLUDED.tier,
            status = 'active', price_usd = EXCLUDED.price_usd,
            current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end,
            cancel_at_period_end = false, canceled_at = NULL, updated_at = now();
      v_result := jsonb_build_object('success', true, 'kind', 'vip', 'tier', v_effective_tier, 'expires_at', v_expires);

    ELSIF v_type = 'CANCELLATION' THEN
      -- Auto-renew turned off. Access runs to the paid-through date.
      UPDATE public.vip_subscriptions
         SET cancel_at_period_end = true, canceled_at = now(),
             cancel_reason = COALESCE(p_event ->> 'cancel_reason', cancel_reason), updated_at = now()
       WHERE user_id = v_user_id AND stripe_subscription_id = 'iap:' || v_orig_txn;
      v_result := jsonb_build_object('success', true, 'kind', 'vip', 'cancel_at_period_end', true);

    ELSIF v_type IN ('EXPIRATION') THEN
      UPDATE public.vip_subscriptions
         SET status = 'canceled', canceled_at = COALESCE(canceled_at, now()), updated_at = now()
       WHERE user_id = v_user_id AND stripe_subscription_id = 'iap:' || v_orig_txn;
      IF v_profile.vip_tier IS DISTINCT FROM 'lifetime'
         AND (v_profile.vip_expires_at IS NULL OR v_profile.vip_expires_at <= now()) THEN
        UPDATE public.profiles SET is_vip = false, updated_at = now() WHERE id = v_user_id;
        v_result := jsonb_build_object('success', true, 'kind', 'vip', 'expired', true, 'is_vip', false);
      ELSE
        v_result := jsonb_build_object('success', true, 'kind', 'vip', 'expired', true, 'is_vip', true,
                                       'reason', 'other_coverage_still_active');
      END IF;

    ELSIF v_type = 'BILLING_ISSUE' THEN
      UPDATE public.vip_subscriptions SET status = 'past_due', updated_at = now()
       WHERE user_id = v_user_id AND stripe_subscription_id = 'iap:' || v_orig_txn;
      v_result := jsonb_build_object('success', true, 'kind', 'vip', 'past_due', true);

    ELSE
      v_result := jsonb_build_object('success', true, 'ignored', true, 'kind', 'vip', 'reason', 'no_settlement_for_type', 'type', v_type);
    END IF;
  END IF;

  UPDATE public.iap_events SET processed_at = now(), result = v_result WHERE event_id = v_event_id;
  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.fn_iap_settle_event(jsonb) IS
  'Store-billing webhook consumer (RevenueCat). Service role only. Diamonds settle through settle_diamond_card_purchase_atomic keyed iap:<transaction>; VIP applies the Stripe webhook''s tier/expiry rules. Idempotent on the event id.';

REVOKE ALL ON FUNCTION public.fn_iap_settle_event(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_iap_settle_event(jsonb) TO service_role;

COMMIT;
