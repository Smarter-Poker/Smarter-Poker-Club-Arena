-- ═══════════════════════════════════════════════════════════════════════════
--  VIP IS MONTHLY, YEARLY OR LIFETIME
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-09-05, verbatim: "We don't sell bronze silver or gold, just vip,
-- monthly, yearly or lifetime, add lifetime for $499."
--
-- FOUR VOCABULARIES, NONE OF THEM AGREEING
--
-- Before this migration the platform used four different words for the same
-- thing, in four places:
--
--   profiles.vip_tier                'lifetime' | 'monthly' | null   (the truth)
--   purchase_vip_with_diamonds_...   'daily' | 'monthly' | 'annual'  (the seller)
--   vip_subscriptions.tier CHECK     'monthly' | 'annual'            (the Stripe row)
--   vip_pricing.tier                 'bronze' | 'silver' | 'gold'    (nine dead rows)
--
-- `resolveVipStatus` treats anything that is not 'lifetime' as a timed
-- membership, so nothing was visibly broken - but a plan sold as 'annual' wrote
-- 'annual' into a column the rest of the platform reads as "some kind of VIP",
-- and `vip_pricing` priced three tiers that do not exist and that nothing reads.
--
-- Dan's ruling settles it. One product, VIP, sold in three terms:
--
--     Monthly    $19.99     1,999 diamonds     30 days
--     Yearly    $199.99    19,999 diamonds    365 days
--     Lifetime  $499.00    49,900 diamonds    never expires
--
-- 100 diamonds per dollar throughout, which is the rate the diamond packs
-- already use (the Whale pack is 50,000 diamonds for $500). Monthly and Yearly
-- keep the prices they had; only the word "Annual" changes. Lifetime is new and
-- is Dan's number.
--
-- THE DAILY PASS IS RETIRED
--
-- A 24-hour, 150-diamond pass is not one of the four terms Dan named. Retiring
-- it takes nothing from anyone, measured 2026-09-05:
--
--     diamond_transactions where transaction_type = 'vip_daily'      0
--     diamond_purchases carrying a 'vip_daily' redemption intent     0
--     vip_subscriptions rows (any plan, any tier)                    0
--     profiles.vip_tier = 'daily' or 'annual'                        0
--
-- NOT ONE VIP MEMBERSHIP HAS EVER BEEN SOLD, on any plan, by card or by
-- diamonds. The 21 human lifetime members and 11 active monthly ones were
-- granted, not purchased. So this migration changes only what a FUTURE buyer is
-- offered, which is exactly the decision Dan just made (CLAUDE.md 10.9).
--
-- The dead 'vip_daily' branch inside settle_diamond_card_purchase_atomic is
-- left in place rather than rewritten. It is now unreachable - nothing writes
-- that redemption intent any more - and if it somehow fired it would get
-- `invalid_arguments` back from the function below, which marks the purchase
-- `redemption_status: 'needs_review'` and LEAVES THE PLAYER THEIR DIAMONDS.
-- That is a safe failure, and it is a better trade than retyping 160 lines of
-- a settled-payments function to delete two.
--
-- One transaction, per the production DDL policy in CLAUDE.md section 2.

BEGIN;

-- ── 0. Nothing has been sold. Assert it, and abort if that changed. ─────────
DO $guard$
DECLARE
  v_subs   bigint;
  v_bought bigint;
  v_daily  bigint;
BEGIN
  SELECT count(*) INTO v_subs   FROM public.vip_subscriptions;
  SELECT count(*) INTO v_bought FROM public.diamond_transactions
   WHERE transaction_type IN ('vip_membership', 'vip_daily');
  SELECT count(*) INTO v_daily  FROM public.profiles WHERE lower(vip_tier) IN ('daily', 'annual');

  IF v_subs <> 0 OR v_bought <> 0 OR v_daily <> 0 THEN
    RAISE EXCEPTION
      'ABORTING: a VIP plan has been sold since this was measured '
      '(subscriptions=%, diamond purchases=%, profiles on a retired tier=%). '
      'Someone now owns a plan this migration renames or retires. Read those '
      'rows and decide what they become before applying.',
      v_subs, v_bought, v_daily;
  END IF;
END;
$guard$;

-- ── 1. The Stripe row accepts the words the product uses ───────────────────
ALTER TABLE public.vip_subscriptions DROP CONSTRAINT IF EXISTS vip_subscriptions_tier_check;
ALTER TABLE public.vip_subscriptions
  ADD CONSTRAINT vip_subscriptions_tier_check
  CHECK (tier = ANY (ARRAY['monthly'::text, 'yearly'::text, 'lifetime'::text]));

COMMENT ON COLUMN public.vip_subscriptions.tier IS
  'monthly | yearly | lifetime. Was monthly|annual until 2026-09-05 (Dan: '
  '"just vip, monthly, yearly or lifetime"). Free to widen: the table was empty. '
  'A lifetime row is a receipt, not a subscription - it never renews.';

-- ── 2. The seller speaks the same three words, and lifetime never expires ──
CREATE OR REPLACE FUNCTION public.purchase_vip_with_diamonds_atomic(
  p_user_id uuid, p_cost integer, p_days integer, p_plan text,
  p_reference_id text, p_description text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_profile public.profiles%ROWTYPE;
    v_wallet jsonb;
    v_now timestamptz := now();
    v_base timestamptz;
    v_expires timestamptz;
    v_tier text;
    v_existing_rank integer;
    v_requested_rank integer;
    v_lifetime boolean := (p_plan = 'lifetime');
BEGIN
    /* THE THREE TERMS. Was ('daily','monthly','annual') until 2026-09-05.
       `p_days` is required for the two timed plans and IGNORED for lifetime,
       which has no end to compute - the old guard demanded p_days > 0 from
       every caller, so a lifetime purchase had no way to say "forever". */
    IF p_cost IS NULL OR p_cost <= 0
       OR p_reference_id IS NULL OR p_reference_id = ''
       OR p_plan NOT IN ('monthly', 'yearly', 'lifetime')
       OR (NOT v_lifetime AND (p_days IS NULL OR p_days <= 0)) THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_arguments');
    END IF;

    -- Serialize every debit + extension for this profile. The nested wallet
    -- function takes the same row lock and writes the ledger in this transaction.
    PERFORM 1
      FROM public.profiles
     WHERE id = p_user_id
     FOR UPDATE;

    SELECT * INTO v_profile FROM public.profiles WHERE id = p_user_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'profile_not_found');
    END IF;

    v_wallet := public.add_diamonds_to_balance(
        p_user_id,
        -p_cost,
        'vip_membership',
        p_description,
        p_reference_id
    );

    IF COALESCE((v_wallet ->> 'success')::boolean, false) IS NOT TRUE THEN
        IF COALESCE((v_wallet ->> 'duplicate')::boolean, false) THEN
            SELECT * INTO v_profile FROM public.profiles WHERE id = p_user_id;
            RETURN jsonb_build_object(
                'success', true,
                'duplicate', true,
                'new_balance', COALESCE(v_profile.diamonds, 0),
                'is_vip', COALESCE(v_profile.is_vip, false),
                'tier', v_profile.vip_tier,
                'expires_at', v_profile.vip_expires_at
            );
        END IF;
        RETURN v_wallet;
    END IF;

    IF v_lifetime THEN
        /* NO EXPIRY AT ALL, not a distant one. expire_lapsed_vip is guarded
           twice - `vip_expires_at IS NOT NULL` and `vip_tier <> 'lifetime'` -
           and a NULL satisfies the first guard on its own. 692 existing
           lifetime rows carry a 2099-12-31 sentinel and 329 carry NULL;
           `resolveVipStatus` reads both correctly, and NULL is the one that
           cannot be misread as a date that has passed. */
        v_tier := 'lifetime';
        v_expires := NULL;
    ELSE
        v_base := CASE
            WHEN v_profile.vip_expires_at IS NOT NULL AND v_profile.vip_expires_at > v_now
                THEN v_profile.vip_expires_at
            ELSE v_now
        END;
        v_expires := v_base + make_interval(days => p_days);

        /* A shorter plan bought on top of a longer one EXTENDS it and keeps the
           better term. 'daily' is gone from the ranking and 'annual' is now
           'yearly'; lifetime sits above both and is unreachable here because
           v2 refuses a purchase by anyone who already holds it. */
        v_existing_rank := CASE v_profile.vip_tier
            WHEN 'lifetime' THEN 3 WHEN 'yearly' THEN 2 WHEN 'monthly' THEN 1 ELSE 0 END;
        v_requested_rank := CASE p_plan
            WHEN 'lifetime' THEN 3 WHEN 'yearly' THEN 2 WHEN 'monthly' THEN 1 ELSE 0 END;
        v_tier := CASE
            WHEN v_profile.vip_expires_at > v_now AND v_existing_rank > v_requested_rank
                THEN v_profile.vip_tier
            ELSE p_plan
        END;
    END IF;

    UPDATE public.profiles
       SET is_vip = true,
           vip_tier = v_tier,
           vip_expires_at = v_expires,
           updated_at = v_now
     WHERE id = p_user_id;

    RETURN jsonb_build_object(
        'success', true,
        'duplicate', false,
        'new_balance', v_wallet -> 'new_balance',
        'is_vip', true,
        'tier', v_tier,
        'expires_at', v_expires
    );
END;
$function$;

COMMENT ON FUNCTION public.purchase_vip_with_diamonds_atomic(uuid, integer, integer, text, text, text) IS
  'Buys VIP with diamonds. Plans are monthly | yearly | lifetime (Dan '
  '2026-09-05); daily and annual were retired the same day, unsold. A lifetime '
  'purchase writes vip_tier = lifetime with a NULL expiry and ignores p_days.';

/* NOBODY IN A BROWSER CALLS THIS. It takes the buyer as a PARAMETER and is
   SECURITY DEFINER, so a caller who could reach it would be handing it its own
   answer to "whose diamonds am I spending". The only route in is
   /api/store/purchase-vip-with-diamonds, which authenticates the bearer token
   itself and reaches the v3 wrapper with the service role.

   Stated explicitly rather than left to the [autorevoke] event trigger, which
   already strips PUBLIC and anon: a grant that exists only because a trigger
   removed the others is a grant nobody can read in the file. PUBLIC is named
   alongside the roles because revoking a role while PUBLIC still holds it
   reads as a fix and does nothing. */
REVOKE ALL ON FUNCTION public.purchase_vip_with_diamonds_atomic(uuid, integer, integer, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purchase_vip_with_diamonds_atomic(uuid, integer, integer, text, text, text)
  TO service_role;

-- ── 3. The price table stops describing a product that never existed ───────
DELETE FROM public.vip_pricing;

/* duration_days is NOT NULL, so lifetime is written as the sentinel the rest of
   the platform already uses for "does not end": 2099-12-31 is roughly 26,780
   days out, and 36,500 is a round century. Nothing computes an expiry from this
   table - see the comment below - so the number is descriptive only. */
INSERT INTO public.vip_pricing (tier, duration_days, diamond_cost, is_active) VALUES
  ('monthly',     30,  1999, true),
  ('yearly',     365, 19999, true),
  ('lifetime', 36500, 49900, true);

COMMENT ON TABLE public.vip_pricing IS
  'The three VIP terms and their diamond prices (Dan 2026-09-05). NOTHING READS '
  'THIS TABLE - no function, no view, no client code; the seller derives its '
  'diamond cost from the USD price in the World Hub''s diamondStoreData.js at '
  '100 diamonds per dollar. Held nine bronze/silver/gold rows for a ladder that '
  'never existed until today. Kept, and now true, so it stops being a lie a '
  'future reader could act on. duration_days on the lifetime row is descriptive: '
  'a lifetime membership is stored as a NULL vip_expires_at.';

COMMIT;
