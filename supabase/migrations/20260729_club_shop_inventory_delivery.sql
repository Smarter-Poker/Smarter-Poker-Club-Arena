-- Marketplace delivery: every club-shop purchase becomes an OWNED inventory item
-- (previously purchases were a receipt-only log with nothing granted). A trigger
-- delivers on every INSERT into club_shop_purchases, so it works regardless of the
-- purchase code path (the World Hub API route, admin grants, etc.). Idempotent via
-- unique purchase_id. Redemption via fn_redeem_shop_item (owner-only).
-- Applied to production via Supabase MCP on 2026-07-29.

CREATE TABLE IF NOT EXISTS public.club_shop_inventory (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  club_id      uuid NOT NULL,
  item_id      uuid,
  purchase_id  uuid UNIQUE,
  item_name    text,
  category     text,
  price_paid   numeric DEFAULT 0,
  status       text NOT NULL DEFAULT 'owned',
  acquired_at  timestamptz NOT NULL DEFAULT now(),
  redeemed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_club_shop_inventory_user ON public.club_shop_inventory(user_id, status);
CREATE INDEX IF NOT EXISTS idx_club_shop_inventory_club ON public.club_shop_inventory(club_id);

ALTER TABLE public.club_shop_inventory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS csi_select_own ON public.club_shop_inventory;
CREATE POLICY csi_select_own ON public.club_shop_inventory FOR SELECT
  USING (
    auth.uid() = user_id
    OR EXISTS (SELECT 1 FROM clubs c WHERE c.id = club_shop_inventory.club_id AND c.owner_id = auth.uid())
  );

CREATE OR REPLACE FUNCTION public.fn_deliver_shop_purchase()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_name text; v_cat text;
BEGIN
  SELECT name, category INTO v_name, v_cat FROM club_shop_items WHERE id = NEW.item_id;
  INSERT INTO club_shop_inventory (user_id, club_id, item_id, purchase_id, item_name, category, price_paid)
  VALUES (NEW.buyer_id, NEW.club_id, NEW.item_id, NEW.id, v_name, v_cat, NEW.price_paid)
  ON CONFLICT (purchase_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deliver_shop_purchase ON public.club_shop_purchases;
CREATE TRIGGER trg_deliver_shop_purchase
  AFTER INSERT ON public.club_shop_purchases
  FOR EACH ROW EXECUTE FUNCTION public.fn_deliver_shop_purchase();

INSERT INTO club_shop_inventory (user_id, club_id, item_id, purchase_id, item_name, category, price_paid, acquired_at)
SELECT p.buyer_id, p.club_id, p.item_id, p.id, i.name, i.category, p.price_paid, p.created_at
FROM club_shop_purchases p
LEFT JOIN club_shop_items i ON i.id = p.item_id
WHERE NOT EXISTS (SELECT 1 FROM club_shop_inventory ci WHERE ci.purchase_id = p.id);

CREATE OR REPLACE FUNCTION public.fn_redeem_shop_item(p_inventory_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row club_shop_inventory;
BEGIN
  SELECT * INTO v_row FROM club_shop_inventory WHERE id = p_inventory_id FOR UPDATE;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'not_found'); END IF;
  IF v_row.user_id <> auth.uid() THEN RETURN jsonb_build_object('success', false, 'error', 'not_authorized'); END IF;
  IF v_row.status = 'redeemed' THEN RETURN jsonb_build_object('success', false, 'error', 'already_redeemed'); END IF;
  UPDATE club_shop_inventory SET status='redeemed', redeemed_at=now() WHERE id = p_inventory_id;
  RETURN jsonb_build_object('success', true, 'item_name', v_row.item_name);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_redeem_shop_item(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_redeem_shop_item(uuid) TO authenticated, service_role;
