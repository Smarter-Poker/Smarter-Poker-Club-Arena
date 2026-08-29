-- ═══════════════════════════════════════════════════════════════════════════
-- PURCHASE → ENTITLEMENT IN ONE TRANSACTION, 2026-08-29
-- ═══════════════════════════════════════════════════════════════════════════
-- A club-shop purchase previously created an inventory row and stopped. The
-- member then had to find My Items and press Redeem before the paid benefit
-- existed. Permanent cosmetics became purchasable again after that redemption
-- because fn_shop_item_availability only considered inventory.status='owned'.
--
-- This migration makes every sellable club item executable and delivers its
-- grant in the purchase trigger. Legacy undelivered inventory is fulfilled and
-- remains redeemable only as a recovery path. Products whose grant is `none`
-- are withdrawn; no checkout may charge for a promise with no implementation.

-- ── 1. Repair legacy item definitions before enforcing the contract ───────

UPDATE public.club_shop_items
   SET grant_spec = CASE category
     WHEN 'Time Banks'  THEN jsonb_build_object('type', 'time_bank',  'qty', 1)
     WHEN 'Throwables'  THEN jsonb_build_object('type', 'throwable',  'qty', 1)
     WHEN 'Emotes'      THEN jsonb_build_object('type', 'emote_pack')
     ELSE grant_spec
   END
 WHERE (grant_spec IS NULL OR COALESCE(grant_spec->>'type', '') = '')
   AND category IN ('Time Banks', 'Throwables', 'Emotes');

-- There is no fulfillment worker or claim-management surface for `none`.
-- These three production rows had no sales when audited; hiding is reversible.
UPDATE public.club_shop_items
   SET is_active = false
 WHERE is_active
   AND (grant_spec IS NULL OR COALESCE(grant_spec->>'type', 'none') = 'none');

-- The old Exclusive VIP-rail SKU and the six manual VIP rewards all created a
-- receipt somebody might fulfil someday. Zero live claims existed at deploy;
-- abort if that changes so an owed benefit is never hidden silently.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.vip_reward_claims c
      JOIN public.vip_reward_catalog r ON r.id = c.reward_id
     WHERE c.status = 'pending' AND r.grant_type = 'manual'
  ) THEN
    RAISE EXCEPTION 'manual VIP rewards have pending claims; fulfil or refund them before withdrawal';
  END IF;
END
$$;

UPDATE public.vip_reward_catalog SET is_active = false WHERE grant_type = 'manual';

-- ── 2. One validation gate for every club-shop write ──────────────────────

CREATE OR REPLACE FUNCTION public.trg_validate_shop_theme_preset()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_type       text := COALESCE(NEW.grant_spec->>'type', 'none');
  v_expected   text;
  v_theme_id   text;
  v_avatar_id  text;
  v_qty        integer;
BEGIN
  v_expected := CASE NEW.category
    WHEN 'Time Banks' THEN 'time_bank'
    WHEN 'Table Skins' THEN 'table_skin'
    WHEN 'Throwables' THEN 'throwable'
    WHEN 'Emotes' THEN 'emote_pack'
    WHEN 'Avatars' THEN 'avatar'
    ELSE NULL
  END;

  IF COALESCE(NEW.is_active, false) THEN
    IF v_type NOT IN ('time_bank', 'throwable', 'emote_pack', 'table_skin', 'avatar') THEN
      RAISE EXCEPTION 'Active shop item has no executable grant'
        USING ERRCODE = '23514';
    END IF;
    IF v_expected IS NULL OR v_type <> v_expected THEN
      RAISE EXCEPTION 'Shop category "%" cannot deliver grant type "%"', NEW.category, v_type
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_type IN ('time_bank', 'throwable') THEN
    BEGIN
      v_qty := COALESCE((NEW.grant_spec->>'qty')::integer, 1);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Invalid shop grant quantity' USING ERRCODE = '23514';
    END;
    IF v_qty < 1 OR v_qty > 1000 THEN
      RAISE EXCEPTION 'Shop grant quantity must be between 1 and 1000'
        USING ERRCODE = '23514';
    END IF;
    NEW.grant_spec := jsonb_set(NEW.grant_spec, '{qty}', to_jsonb(v_qty), true);
  ELSIF v_type = 'table_skin' THEN
    v_theme_id := public.sp_resolve_theme_preset(NEW.grant_spec->>'theme_id');
    IF v_theme_id IS NULL THEN
      RAISE EXCEPTION 'Unknown Table Studio theme "%"', NEW.grant_spec->>'theme_id'
        USING ERRCODE = '23514';
    END IF;
    NEW.grant_spec := jsonb_set(NEW.grant_spec, '{theme_id}', to_jsonb(v_theme_id), true);
    NEW.stackable := false;
  ELSIF v_type = 'avatar' THEN
    v_avatar_id := public.sp_resolve_avatar_shop_sku(NEW.grant_spec->>'avatar_id');
    IF v_avatar_id IS NULL THEN
      RAISE EXCEPTION 'Unknown avatar-library SKU "%"', NEW.grant_spec->>'avatar_id'
        USING ERRCODE = '23514';
    END IF;
    NEW.grant_spec := jsonb_set(NEW.grant_spec, '{avatar_id}', to_jsonb(v_avatar_id), true);
    NEW.stackable := false;
  ELSIF v_type = 'emote_pack' THEN
    NEW.stackable := false;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_shop_theme_preset ON public.club_shop_items;
CREATE TRIGGER trg_validate_shop_theme_preset
  BEFORE INSERT OR UPDATE OF grant_spec, is_active, category, stackable
  ON public.club_shop_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_validate_shop_theme_preset();

-- Normalize permanent rows through the validation trigger now, including any
-- club owner who had incorrectly marked a permanent unlock stackable.
UPDATE public.club_shop_items SET grant_spec = grant_spec
 WHERE COALESCE(grant_spec->>'type', '') IN ('table_skin', 'avatar', 'emote_pack');

-- ── 3. Shared grant primitive used by checkout and legacy redemption ──────

CREATE OR REPLACE FUNCTION public.sp_grant_shop_item(
  p_user_id uuid,
  p_item_id uuid,
  p_unlock_method text DEFAULT 'club_shop_purchase'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_spec    jsonb;
  v_type    text;
  v_qty     integer;
  v_ref     text;
BEGIN
  SELECT grant_spec INTO v_spec FROM public.club_shop_items WHERE id = p_item_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'item_gone');
  END IF;

  v_type := COALESCE(v_spec->>'type', 'none');
  BEGIN
    v_qty := GREATEST(1, LEAST(1000, COALESCE((v_spec->>'qty')::integer, 1)));
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_grant_quantity');
  END;

  IF v_type = 'time_bank' THEN
    INSERT INTO public.feature_purchases
      (user_id, feature, cost, usage_type, uses_remaining, expires_at)
    VALUES (p_user_id, 'time_bank_seconds', 0, 'per_use', v_qty, NULL);
    RETURN jsonb_build_object(
      'success', true, 'type', v_type, 'uses', v_qty, 'seconds', v_qty * 20,
      'permanent', false
    );
  ELSIF v_type = 'throwable' THEN
    INSERT INTO public.feature_purchases
      (user_id, feature, cost, usage_type, uses_remaining, expires_at)
    VALUES (p_user_id, 'throwable', 0, 'per_use', v_qty, NULL);
    RETURN jsonb_build_object(
      'success', true, 'type', v_type, 'uses', v_qty, 'permanent', false
    );
  ELSIF v_type = 'emote_pack' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.feature_purchases
       WHERE user_id = p_user_id AND feature = 'emoji_pack'
         AND (expires_at IS NULL OR expires_at > now())
    ) THEN
      INSERT INTO public.feature_purchases
        (user_id, feature, cost, usage_type, uses_remaining, expires_at)
      VALUES (p_user_id, 'emoji_pack', 0, 'permanent', NULL, NULL);
    END IF;
    RETURN jsonb_build_object('success', true, 'type', v_type, 'permanent', true);
  ELSIF v_type = 'table_skin' THEN
    v_ref := public.sp_resolve_theme_preset(v_spec->>'theme_id');
    IF v_ref IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_theme_sku');
    END IF;
    PERFORM public.sp_grant_theme_preset(p_user_id, v_ref, p_unlock_method);
    RETURN jsonb_build_object(
      'success', true, 'type', v_type, 'theme_id', v_ref, 'permanent', true
    );
  ELSIF v_type = 'avatar' THEN
    v_ref := public.sp_resolve_avatar_shop_sku(v_spec->>'avatar_id');
    IF v_ref IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'invalid_avatar_sku');
    END IF;
    INSERT INTO public.avatar_unlocks (user_id, avatar_id, unlock_method)
    VALUES (p_user_id, v_ref, p_unlock_method) ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object(
      'success', true, 'type', v_type, 'avatar_id', v_ref, 'permanent', true
    );
  END IF;

  RETURN jsonb_build_object('success', false, 'error', 'unfulfillable_item');
END;
$$;

REVOKE ALL ON FUNCTION public.sp_grant_shop_item(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;

-- ── 4. Checkout now delivers before the purchase transaction commits ─────

CREATE OR REPLACE FUNCTION public.fn_deliver_shop_purchase()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_name         text;
  v_category     text;
  v_inventory_id uuid;
  v_granted      jsonb;
  v_permanent    boolean;
BEGIN
  SELECT name, category INTO v_name, v_category
    FROM public.club_shop_items WHERE id = NEW.item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cannot deliver missing shop item %', NEW.item_id;
  END IF;

  INSERT INTO public.club_shop_inventory
    (user_id, club_id, item_id, purchase_id, item_name, category, price_paid)
  VALUES
    (NEW.buyer_id, NEW.club_id, NEW.item_id, NEW.id, v_name, v_category, NEW.price_paid)
  ON CONFLICT (purchase_id) DO NOTHING
  RETURNING id INTO v_inventory_id;

  IF v_inventory_id IS NULL THEN RETURN NEW; END IF;

  v_granted := public.sp_grant_shop_item(NEW.buyer_id, NEW.item_id, 'club_shop_purchase');
  IF COALESCE((v_granted->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Shop entitlement delivery failed: %',
      COALESCE(v_granted->>'error', 'unknown');
  END IF;

  v_permanent := COALESCE((v_granted->>'permanent')::boolean, false);
  UPDATE public.club_shop_inventory
     SET status = CASE WHEN v_permanent THEN 'owned' ELSE 'redeemed' END,
         redeemed_at = now()
   WHERE id = v_inventory_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deliver_shop_purchase ON public.club_shop_purchases;
CREATE TRIGGER trg_deliver_shop_purchase
  AFTER INSERT ON public.club_shop_purchases
  FOR EACH ROW EXECUTE FUNCTION public.fn_deliver_shop_purchase();

-- ── 5. Legacy Redeem remains an idempotent recovery path ──────────────────

CREATE OR REPLACE FUNCTION public.fn_redeem_shop_item(p_inventory_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_row       public.club_shop_inventory;
  v_uid       uuid := auth.uid();
  v_granted   jsonb;
  v_permanent boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  SELECT * INTO v_row FROM public.club_shop_inventory
   WHERE id = p_inventory_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_found');
  END IF;
  IF v_row.user_id <> v_uid THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  IF v_row.redeemed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true, 'already_delivered', true, 'user_id', v_uid,
      'item_name', v_row.item_name
    );
  END IF;

  v_granted := public.sp_grant_shop_item(v_uid, v_row.item_id, 'club_shop_recovery');
  IF COALESCE((v_granted->>'success')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'success', false, 'error', COALESCE(v_granted->>'error', 'grant_failed')
    );
  END IF;

  v_permanent := COALESCE((v_granted->>'permanent')::boolean, false);
  UPDATE public.club_shop_inventory
     SET status = CASE WHEN v_permanent THEN 'owned' ELSE 'redeemed' END,
         redeemed_at = now()
   WHERE id = p_inventory_id;

  RETURN jsonb_build_object(
    'success', true, 'user_id', v_uid, 'item_name', v_row.item_name,
    'granted', v_granted - 'success' - 'permanent'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_redeem_shop_item(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_redeem_shop_item(uuid) TO authenticated, service_role;

-- ── 6. Permanent ownership is an entitlement, not an inventory status ────

CREATE OR REPLACE FUNCTION public.fn_shop_item_availability(
  p_club_id uuid,
  p_user_id uuid,
  p_item_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_item      public.club_shop_items;
  v_owned     integer;
  v_purchased integer;
  v_price     integer;
  v_type      text;
  v_ref       text;
BEGIN
  SELECT * INTO v_item FROM public.club_shop_items
   WHERE id = p_item_id AND club_id = p_club_id;

  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF NOT COALESCE(v_item.is_active, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'inactive');
  END IF;
  IF v_item.available_from IS NOT NULL AND now() < v_item.available_from THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'not_yet_available', 'available_from', v_item.available_from
    );
  END IF;
  IF v_item.available_until IS NOT NULL AND now() >= v_item.available_until THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_longer_available');
  END IF;
  IF v_item.stock IS NOT NULL AND v_item.stock <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'sold_out');
  END IF;

  v_type := COALESCE(v_item.grant_spec->>'type', 'none');
  IF v_type = 'table_skin' THEN
    v_ref := public.sp_resolve_theme_preset(v_item.grant_spec->>'theme_id');
    IF EXISTS (
      SELECT 1 FROM public.theme_asset_unlocks
       WHERE user_id = p_user_id AND category = 'theme_id' AND asset_id = v_ref
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_owned');
    END IF;
  ELSIF v_type = 'avatar' THEN
    v_ref := public.sp_resolve_avatar_shop_sku(v_item.grant_spec->>'avatar_id');
    IF EXISTS (
      SELECT 1 FROM public.avatar_unlocks WHERE user_id = p_user_id AND avatar_id = v_ref
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_owned');
    END IF;
  ELSIF v_type = 'emote_pack' THEN
    IF EXISTS (
      SELECT 1 FROM public.feature_purchases
       WHERE user_id = p_user_id AND feature = 'emoji_pack'
         AND (expires_at IS NULL OR expires_at > now())
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_owned');
    END IF;
  END IF;

  IF NOT COALESCE(v_item.stackable, false) THEN
    SELECT count(*) INTO v_owned FROM public.club_shop_inventory
     WHERE club_id = p_club_id AND user_id = p_user_id
       AND item_id = p_item_id AND status = 'owned';
    IF v_owned > 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_owned');
    END IF;
  END IF;

  IF v_item.per_user_limit IS NOT NULL THEN
    SELECT count(*) INTO v_purchased FROM public.club_shop_purchases
     WHERE club_id = p_club_id AND buyer_id = p_user_id
       AND item_id = p_item_id AND refunded_at IS NULL;
    IF v_purchased >= v_item.per_user_limit THEN
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'limit_reached', 'limit', v_item.per_user_limit
      );
    END IF;
  END IF;

  v_price := COALESCE(v_item.sale_price, v_item.price);
  RETURN jsonb_build_object(
    'ok', true, 'price', v_price, 'list_price', v_item.price,
    'on_sale', v_item.sale_price IS NOT NULL AND v_item.sale_price < v_item.price,
    'stackable', COALESCE(v_item.stackable, false),
    'stock_limited', v_item.stock IS NOT NULL
  );
END;
$$;

-- Auto-delivered inventory cannot be refunded while its entitlement remains.
CREATE OR REPLACE FUNCTION public.fn_refund_shop_purchase(
  p_club_id uuid,
  p_purchase_id uuid,
  p_actor_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_purchase public.club_shop_purchases;
  v_inv      public.club_shop_inventory;
  v_credit   jsonb;
BEGIN
  SELECT * INTO v_purchase FROM public.club_shop_purchases
   WHERE id = p_purchase_id AND club_id = p_club_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'purchase_not_found');
  END IF;
  IF v_purchase.refunded_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true, 'already_refunded', true, 'amount', v_purchase.price_paid
    );
  END IF;

  SELECT * INTO v_inv FROM public.club_shop_inventory
   WHERE purchase_id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_delivered');
  END IF;
  IF v_inv.status = 'redeemed' OR v_inv.redeemed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'already_redeemed',
      'detail', 'The purchased benefit was already delivered and cannot be revoked automatically.'
    );
  END IF;

  IF v_inv.status <> 'refunded' THEN
    UPDATE public.club_shop_inventory SET status = 'refunded' WHERE id = v_inv.id;
  END IF;

  IF v_purchase.currency = 'diamonds' THEN
    v_credit := public.add_diamonds_to_balance(
      v_purchase.buyer_id, v_purchase.price_paid, 'refund',
      COALESCE(NULLIF(p_reason, ''), 'Club Shop Purchase Refund'),
      'ca-shop-refund-' || p_purchase_id::text
    );
    IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE
       AND COALESCE((v_credit->>'duplicate')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'diamond refund credit failed: %', COALESCE(v_credit->>'error', 'unknown');
    END IF;
  ELSE
    v_credit := public.fn_credit_chips(
      p_club_id, v_purchase.buyer_id, v_purchase.price_paid,
      COALESCE(NULLIF(p_reason, ''), 'Shop purchase refund'),
      jsonb_build_object(
        'transaction_type', 'refund', 'purchase_id', p_purchase_id,
        'refunded_by', p_actor_id
      )
    );
    IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'refund credit failed: %', COALESCE(v_credit->>'error', 'unknown');
    END IF;
  END IF;

  UPDATE public.club_shop_purchases SET refunded_at = now() WHERE id = p_purchase_id;
  IF v_purchase.stock_claimed THEN
    UPDATE public.club_shop_items SET stock = stock + 1
     WHERE id = v_purchase.item_id AND club_id = p_club_id AND stock IS NOT NULL;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'amount', v_purchase.price_paid, 'currency', v_purchase.currency,
    'buyer_id', v_purchase.buyer_id,
    'balance_after', COALESCE(v_credit->'new_balance', v_credit->'balance_after')
  );
END;
$$;

-- Both writers are implementation details behind trusted trigger/API paths.
-- CREATE OR REPLACE preserves old ACLs, so close every browser role explicitly
-- after both definitions and leave service_role as the only direct caller.
REVOKE ALL ON FUNCTION public.sp_grant_shop_item(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sp_grant_shop_item(uuid, uuid, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.fn_refund_shop_purchase(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_refund_shop_purchase(uuid, uuid, uuid, text)
  TO service_role;

-- ── 7. Fulfil every historical inventory row still waiting on a click ────

DO $$
DECLARE
  r            record;
  v_granted    jsonb;
  v_permanent  boolean;
BEGIN
  FOR r IN
    SELECT inv.id, inv.user_id, inv.item_id
      FROM public.club_shop_inventory inv
      JOIN public.club_shop_items item ON item.id = inv.item_id
     WHERE inv.status = 'owned' AND inv.redeemed_at IS NULL
       AND COALESCE(item.grant_spec->>'type', 'none') IN
         ('time_bank', 'throwable', 'emote_pack', 'table_skin', 'avatar')
     FOR UPDATE OF inv
  LOOP
    v_granted := public.sp_grant_shop_item(r.user_id, r.item_id, 'club_shop_backfill');
    IF COALESCE((v_granted->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Could not backfill inventory %: %', r.id, v_granted->>'error';
    END IF;
    v_permanent := COALESCE((v_granted->>'permanent')::boolean, false);
    UPDATE public.club_shop_inventory
       SET status = CASE WHEN v_permanent THEN 'owned' ELSE 'redeemed' END,
           redeemed_at = now()
     WHERE id = r.id;
  END LOOP;
END
$$;

-- ── 8. Deployment proofs ──────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.club_shop_items
     WHERE is_active AND COALESCE(grant_spec->>'type', 'none') NOT IN
       ('time_bank', 'throwable', 'emote_pack', 'table_skin', 'avatar')
  ) THEN
    RAISE EXCEPTION 'an active club-shop item still has no executable grant';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.vip_reward_catalog WHERE is_active AND grant_type = 'manual'
  ) THEN
    RAISE EXCEPTION 'an active VIP reward still requires a nonexistent manual workflow';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.club_shop_inventory inv
      JOIN public.club_shop_items item ON item.id = inv.item_id
     WHERE inv.status = 'owned' AND inv.redeemed_at IS NULL
       AND COALESCE(item.grant_spec->>'type', 'none') IN
         ('time_bank', 'throwable', 'emote_pack', 'table_skin', 'avatar')
  ) THEN
    RAISE EXCEPTION 'a paid club-shop inventory row is still undelivered';
  END IF;

  IF position(
    'sp_grant_shop_item' IN pg_get_functiondef(
      'public.fn_deliver_shop_purchase()'::regprocedure
    )
  ) = 0 THEN
    RAISE EXCEPTION 'checkout trigger does not call the entitlement grant';
  END IF;

  IF position(
    'redeemed_at IS NOT NULL' IN pg_get_functiondef(
      'public.fn_refund_shop_purchase(uuid,uuid,uuid,text)'::regprocedure
    )
  ) = 0 THEN
    RAISE EXCEPTION 'refund path can still reverse an already delivered item';
  END IF;
END
$$;
