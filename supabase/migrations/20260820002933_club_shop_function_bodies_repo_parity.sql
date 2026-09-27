-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820002933 "club_shop_function_bodies_repo_parity"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 704f7054f42151eedf16665ce6dae10d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Re-applies the six club-shop function bodies exactly as they exist in
-- supabase/migrations/20260819_club_shop_function_bodies.sql, to PROVE the repo
-- file reproduces production byte-for-byte. Expected to be a no-op.

CREATE OR REPLACE FUNCTION public.fn_shop_item_availability(p_club_id uuid, p_user_id uuid, p_item_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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

CREATE OR REPLACE FUNCTION public.fn_claim_shop_purchase(p_club_id uuid, p_user_id uuid, p_item_id uuid)
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

CREATE OR REPLACE FUNCTION public.fn_deliver_shop_purchase()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_name text; v_cat text; v_stackable boolean;
BEGIN
  SELECT name, category, COALESCE(stackable, false)
    INTO v_name, v_cat, v_stackable
    FROM club_shop_items WHERE id = NEW.item_id;

  INSERT INTO club_shop_inventory (
    user_id, club_id, item_id, purchase_id, item_name, category, price_paid, stackable_snapshot
  )
  VALUES (
    NEW.buyer_id, NEW.club_id, NEW.item_id, NEW.id, v_name, v_cat, NEW.price_paid,
    COALESCE(v_stackable, false)
  )
  ON CONFLICT (purchase_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_deliver_shop_purchase ON public.club_shop_purchases;
CREATE TRIGGER trg_deliver_shop_purchase
  AFTER INSERT ON public.club_shop_purchases
  FOR EACH ROW EXECUTE FUNCTION fn_deliver_shop_purchase();

CREATE OR REPLACE FUNCTION public.fn_refund_shop_purchase(p_club_id uuid, p_purchase_id uuid, p_actor_id uuid, p_reason text DEFAULT NULL::text)
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

CREATE OR REPLACE FUNCTION public.fn_idempotency_begin(p_key text, p_route text, p_ttl_seconds integer DEFAULT 300)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row api_idempotency;
BEGIN
  IF p_key IS NULL OR length(p_key) < 8 THEN
    RETURN jsonb_build_object('claimed', false, 'state', 'invalid');
  END IF;

  -- Opportunistic sweep; cheap and keeps the table from growing unbounded.
  DELETE FROM api_idempotency WHERE expires_at < now();

  INSERT INTO api_idempotency (key, route, state, expires_at)
  VALUES (p_key, p_route, 'processing', now() + make_interval(secs => GREATEST(1, p_ttl_seconds)))
  ON CONFLICT (key) DO NOTHING;

  IF FOUND THEN
    RETURN jsonb_build_object('claimed', true);
  END IF;

  SELECT * INTO v_row FROM api_idempotency WHERE key = p_key;

  IF NOT FOUND THEN
    -- Swept between the INSERT and the SELECT; treat as a fresh claim.
    RETURN jsonb_build_object('claimed', true);
  END IF;

  IF v_row.state = 'done' THEN
    RETURN jsonb_build_object('claimed', false, 'state', 'done',
                              'status', v_row.status, 'body', v_row.body);
  END IF;

  RETURN jsonb_build_object('claimed', false, 'state', 'processing');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_idempotency_finish(p_key text, p_status integer, p_body jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_key IS NULL THEN RETURN; END IF;

  -- Never cache a 5xx: a transient failure would be replayed as a permanent
  -- one for the whole TTL, over an operation that may well have committed.
  IF p_status >= 500 THEN
    DELETE FROM api_idempotency WHERE key = p_key;
    RETURN;
  END IF;

  UPDATE api_idempotency
     SET state = 'done', status = p_status, body = p_body
   WHERE key = p_key;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_shop_item_availability(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_claim_shop_purchase(uuid, uuid, uuid)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_refund_shop_purchase(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_idempotency_begin(text, text, integer)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_idempotency_finish(text, integer, jsonb) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_shop_item_availability(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_claim_shop_purchase(uuid, uuid, uuid)   TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_refund_shop_purchase(uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_idempotency_begin(text, text, integer)  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_idempotency_finish(text, integer, jsonb) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_deliver_shop_purchase') THEN
    RAISE EXCEPTION 'trg_deliver_shop_purchase missing — purchases would not deliver';
  END IF;
END $$;
