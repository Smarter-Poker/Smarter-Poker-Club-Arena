-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820000345 "shop_refund_guard_atomic_cap_and_rls"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 358a5a9b4280140439906ad81c038618 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Audit pass 6 — money-safety and privacy fixes.
--
-- 1) REFUND COULD MINT CHIPS WITHOUT LIMIT. fn_refund_shop_purchase kept its
--    entire idempotency guard inside `IF FOUND` on the club_shop_inventory
--    lookup. With no inventory row (delivery trigger failed, row deleted,
--    purchase predates the trigger) control fell through to fn_credit_chips and
--    NOTHING was marked refunded — so every repeat call credited price_paid
--    again, each returning success and writing a clean audit row.
--    Now: no delivered copy => 'not_delivered', and refunds are recorded on
--    club_shop_purchases.refunded_at, which is the real idempotency marker.
--
-- 2) PER-USER CAP WAS RACY. fn_shop_item_availability counted purchases and the
--    route acted on the count. club_shop_purchases has no unique constraint,
--    and the ownership index deliberately exempts stackable items, so N
--    concurrent buys of a limit-1 stackable item all counted 0 and all
--    succeeded. fn_claim_shop_purchase now takes a per-(user,item) advisory
--    lock INSIDE one function and re-checks the cap and the stock together.
--
-- 3) REFUND INFLATED STOCK. The unit was returned unconditionally, so refunding
--    a purchase made while the item was unlimited invented a unit once the item
--    later became limited. Now gated on club_shop_purchases.stock_claimed.
--
-- 4) redeemed_at was being set on refund, so "items redeemed in period" counted
--    refunds. Refunds now use their own column.
--
-- 5) PURCHASE HISTORY WAS WORLD-READABLE. club_shop_purchases and
--    club_shop_items both had `FOR SELECT TO public USING (true)`, so anyone
--    holding the publishable key that ships in the client bundle could read
--    every purchase in every club (buyer_id, price_paid, created_at) and every
--    club's unreleased items, sale prices and stock. Scoped to the buyer, club
--    members and club staff. The app is unaffected: marketplace-items.js and
--    shop-analytics.js both read through the service role.
--
-- Rollback: see the audit doc; each change is independent.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.club_shop_purchases
  ADD COLUMN IF NOT EXISTS refunded_at   timestamptz,
  ADD COLUMN IF NOT EXISTS stock_claimed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.club_shop_purchases.refunded_at IS
  'Set by fn_refund_shop_purchase. The idempotency marker for refunds.';
COMMENT ON COLUMN public.club_shop_purchases.stock_claimed IS
  'True when this purchase consumed a limited-stock unit, so a refund returns exactly what it took.';

-- Existing rows: a unit was claimed only if the item is limited today. Best
-- effort for history; correct for everything written from here on.
UPDATE public.club_shop_purchases p
SET stock_claimed = true
FROM public.club_shop_items i
WHERE i.id = p.item_id AND i.stock IS NOT NULL AND p.stock_claimed = false;

UPDATE public.club_shop_purchases p
SET refunded_at = inv.redeemed_at
FROM public.club_shop_inventory inv
WHERE inv.purchase_id = p.id AND inv.status = 'refunded' AND p.refunded_at IS NULL;

-- ── Atomic claim: cap + stock decided under one lock ──────────────────────
CREATE OR REPLACE FUNCTION public.fn_claim_shop_purchase(
  p_club_id uuid, p_user_id uuid, p_item_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_avail jsonb;
  v_item  club_shop_items;
  v_found boolean := false;
BEGIN
  -- Serialise this (user, item) for the rest of the caller's transaction.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('shop_buy:' || p_user_id::text || ':' || p_item_id::text, 0)
  );

  v_avail := fn_shop_item_availability(p_club_id, p_user_id, p_item_id);
  IF NOT COALESCE((v_avail->>'ok')::boolean, false) THEN
    RETURN v_avail;
  END IF;

  SELECT * INTO v_item FROM club_shop_items
   WHERE id = p_item_id AND club_id = p_club_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_item.stock IS NOT NULL THEN
    UPDATE club_shop_items
       SET stock = stock - 1
     WHERE id = p_item_id AND club_id = p_club_id AND stock > 0
    RETURNING true INTO v_found;

    IF NOT COALESCE(v_found, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'sold_out');
    END IF;
  END IF;

  RETURN v_avail || jsonb_build_object('stock_claimed', v_item.stock IS NOT NULL);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_claim_shop_purchase(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_shop_purchase(uuid, uuid, uuid) TO service_role;

-- Report whether the item is stock-limited so the route stops re-reading it.
CREATE OR REPLACE FUNCTION public.fn_shop_item_availability(
  p_club_id uuid, p_user_id uuid, p_item_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_item      club_shop_items;
  v_owned     integer;
  v_purchased integer;
  v_price     integer;
BEGIN
  SELECT * INTO v_item FROM club_shop_items
   WHERE id = p_item_id AND club_id = p_club_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF NOT COALESCE(v_item.is_active, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'inactive');
  END IF;
  IF v_item.available_from IS NOT NULL AND now() < v_item.available_from THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_yet_available',
                              'available_from', v_item.available_from);
  END IF;
  IF v_item.available_until IS NOT NULL AND now() >= v_item.available_until THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_longer_available');
  END IF;
  IF v_item.stock IS NOT NULL AND v_item.stock <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'sold_out');
  END IF;

  IF NOT COALESCE(v_item.stackable, false) THEN
    SELECT count(*) INTO v_owned FROM club_shop_inventory
     WHERE club_id = p_club_id AND user_id = p_user_id
       AND item_id = p_item_id AND status = 'owned';
    IF v_owned > 0 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_owned');
    END IF;
  END IF;

  IF v_item.per_user_limit IS NOT NULL THEN
    -- Refunded purchases must not count against the cap.
    SELECT count(*) INTO v_purchased FROM club_shop_purchases
     WHERE club_id = p_club_id AND buyer_id = p_user_id
       AND item_id = p_item_id AND refunded_at IS NULL;
    IF v_purchased >= v_item.per_user_limit THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'limit_reached',
                                'limit', v_item.per_user_limit);
    END IF;
  END IF;

  v_price := COALESCE(v_item.sale_price, v_item.price);

  RETURN jsonb_build_object(
    'ok', true,
    'price', v_price,
    'list_price', v_item.price,
    'on_sale', v_item.sale_price IS NOT NULL AND v_item.sale_price < v_item.price,
    'stackable', COALESCE(v_item.stackable, false),
    'stock_limited', v_item.stock IS NOT NULL
  );
END;
$function$;

-- ── Refund: guarded, idempotent on the purchase row ───────────────────────
CREATE OR REPLACE FUNCTION public.fn_refund_shop_purchase(
  p_club_id uuid, p_purchase_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_purchase club_shop_purchases;
  v_inv      club_shop_inventory;
  v_credit   jsonb;
BEGIN
  SELECT * INTO v_purchase FROM club_shop_purchases
   WHERE id = p_purchase_id AND club_id = p_club_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'purchase_not_found');
  END IF;

  -- Authoritative idempotency marker: lives on the row we just locked, so it
  -- works even when no inventory copy was ever delivered.
  IF v_purchase.refunded_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'already_refunded', true,
                              'amount', v_purchase.price_paid);
  END IF;

  SELECT * INTO v_inv FROM club_shop_inventory
   WHERE purchase_id = p_purchase_id FOR UPDATE;

  IF NOT FOUND THEN
    -- No delivered copy: refunding would credit chips against nothing, and
    -- there would be no artefact to revoke.
    RETURN jsonb_build_object('success', false, 'error', 'not_delivered');
  END IF;

  IF v_inv.status = 'redeemed' THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'already_redeemed',
      'detail', 'The member has already used this item; the granted benefit cannot be taken back automatically.');
  END IF;

  IF v_inv.status <> 'refunded' THEN
    -- redeemed_at is NOT touched: a refund is not a redemption, and reporting
    -- that asks "what was redeemed in this period" must not count refunds.
    UPDATE club_shop_inventory SET status = 'refunded' WHERE id = v_inv.id;
  END IF;

  v_credit := fn_credit_chips(
    p_club_id, v_purchase.buyer_id, v_purchase.price_paid,
    COALESCE(NULLIF(p_reason, ''), 'Shop purchase refund'),
    jsonb_build_object('transaction_type', 'refund', 'purchase_id', p_purchase_id,
                       'refunded_by', p_actor_id));

  IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'refund credit failed: %', COALESCE(v_credit->>'error', 'unknown');
  END IF;

  UPDATE club_shop_purchases SET refunded_at = now() WHERE id = p_purchase_id;

  -- Return exactly what this purchase took, never inventing a unit.
  IF v_purchase.stock_claimed THEN
    UPDATE club_shop_items SET stock = stock + 1
     WHERE id = v_purchase.item_id AND club_id = p_club_id AND stock IS NOT NULL;
  END IF;

  RETURN jsonb_build_object('success', true, 'amount', v_purchase.price_paid,
                            'buyer_id', v_purchase.buyer_id,
                            'balance_after', v_credit->'balance_after');
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_refund_shop_purchase(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_refund_shop_purchase(uuid, uuid, uuid, text) TO service_role;

-- ── RLS: purchase history and catalogue were world-readable ───────────────
DROP POLICY IF EXISTS club_shop_purchases_select ON public.club_shop_purchases;
CREATE POLICY club_shop_purchases_select ON public.club_shop_purchases
  FOR SELECT TO authenticated
  USING (
    buyer_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM club_members m
       WHERE m.club_id = club_shop_purchases.club_id
         AND m.user_id = (SELECT auth.uid())
         AND m.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS club_shop_items_select ON public.club_shop_items;
CREATE POLICY club_shop_items_select ON public.club_shop_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM club_members m
       WHERE m.club_id = club_shop_items.club_id
         AND m.user_id = (SELECT auth.uid())
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='fn_claim_shop_purchase') THEN
    RAISE EXCEPTION 'fn_claim_shop_purchase missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename='club_shop_purchases' AND policyname='club_shop_purchases_select'
       AND 'public' = ANY(roles)
  ) THEN
    RAISE EXCEPTION 'club_shop_purchases is still world-readable';
  END IF;
END $$;
