-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819233241 "fn_refund_shop_purchase"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7d895844ba7e94ad4fa081b1befb5d11 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- fn_refund_shop_purchase — reverse a completed club-shop purchase.
--
-- WHY: nothing could undo a purchase. Automatic rollbacks existed for FAILED
-- purchases, but a member who bought the wrong item, or a club that mispriced
-- something, had no recourse at all — not even the owner.
--
-- Refunding does ALL of this in one transaction, or none of it:
--   * credits the price actually paid back to the member's club balance
--   * marks the inventory copy 'refunded' so it is neither usable nor counted
--     as owned (isOwnedRow treats only 'redeemed' as spent, so 'refunded' is
--     explicitly excluded from the ownership index predicate below)
--   * returns the unit to stock for limited items
--   * writes a chip_transactions row so the club ledger balances
--
-- REFUSES when the item was already redeemed: the entitlement (time bank
-- seconds, throw credits, an avatar unlock) has already been handed over and
-- consuming it back is not something this function can honestly promise.
-- An admin who still wants to refund must adjust chips manually and knowingly.
--
-- Idempotent: a second call on an already-refunded purchase is a no-op success.
--
-- service_role only — /api/club-arena/refund-purchase enforces that the caller
-- is an owner/admin of the club.
--
-- Rollback: DROP FUNCTION public.fn_refund_shop_purchase(uuid, uuid, uuid, text);
-- ═══════════════════════════════════════════════════════════════════════════

-- 'refunded' copies must not block a re-purchase of a non-stackable item.
DROP INDEX IF EXISTS public.uq_shop_inventory_owned_per_item;
CREATE UNIQUE INDEX uq_shop_inventory_owned_per_item
  ON public.club_shop_inventory (user_id, club_id, item_id)
  WHERE status = 'owned' AND stackable_snapshot = false;

CREATE OR REPLACE FUNCTION public.fn_refund_shop_purchase(
  p_club_id     uuid,
  p_purchase_id uuid,
  p_actor_id    uuid,
  p_reason      text DEFAULT NULL
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
  SELECT * INTO v_purchase
    FROM club_shop_purchases
   WHERE id = p_purchase_id AND club_id = p_club_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'purchase_not_found');
  END IF;

  SELECT * INTO v_inv
    FROM club_shop_inventory
   WHERE purchase_id = p_purchase_id
   FOR UPDATE;

  IF FOUND THEN
    IF v_inv.status = 'refunded' THEN
      -- Already done. Idempotent success so a retry cannot double-credit.
      RETURN jsonb_build_object('success', true, 'already_refunded', true,
                                'amount', v_purchase.price_paid);
    END IF;

    IF v_inv.status = 'redeemed' THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'already_redeemed',
        'detail', 'The member has already used this item; the granted benefit cannot be taken back automatically.'
      );
    END IF;

    UPDATE club_shop_inventory
       SET status = 'refunded', redeemed_at = COALESCE(redeemed_at, now())
     WHERE id = v_inv.id;
  END IF;

  -- Give the chips back.
  v_credit := fn_credit_chips(
    p_club_id, v_purchase.buyer_id, v_purchase.price_paid,
    COALESCE(NULLIF(p_reason, ''), 'Shop purchase refund'),
    jsonb_build_object('transaction_type', 'refund', 'purchase_id', p_purchase_id,
                       'refunded_by', p_actor_id)
  );

  IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'refund credit failed: %', COALESCE(v_credit->>'error', 'unknown');
  END IF;

  -- Return the unit to a limited drop.
  UPDATE club_shop_items
     SET stock = stock + 1
   WHERE id = v_purchase.item_id AND club_id = p_club_id AND stock IS NOT NULL;

  RETURN jsonb_build_object(
    'success', true,
    'amount', v_purchase.price_paid,
    'buyer_id', v_purchase.buyer_id,
    'balance_after', v_credit->'balance_after'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_refund_shop_purchase(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_refund_shop_purchase(uuid, uuid, uuid, text) TO service_role;

DO $$
BEGIN
  IF has_function_privilege('authenticated',
       'public.fn_refund_shop_purchase(uuid, uuid, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_refund_shop_purchase must not be executable by authenticated';
  END IF;
END $$;
