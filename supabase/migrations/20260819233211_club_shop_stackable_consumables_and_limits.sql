-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819233211 "club_shop_stackable_consumables_and_limits"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8c229564a0d64cc65ae89e286b4728dd of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Stackable consumables + per-user caps + promo scheduling / sale price.
-- (See 20260819_club_shop_stackable_and_promos.sql in the repo for the full
--  rationale; this is the applied form.)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.club_shop_items
  ADD COLUMN IF NOT EXISTS stackable       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS per_user_limit  integer,
  ADD COLUMN IF NOT EXISTS sale_price      integer,
  ADD COLUMN IF NOT EXISTS available_from  timestamptz,
  ADD COLUMN IF NOT EXISTS available_until timestamptz,
  ADD COLUMN IF NOT EXISTS sort_order      integer NOT NULL DEFAULT 0;

-- Snapshot of items.stackable, written at delivery. The partial index below
-- needs an immutable predicate, so it cannot join back to club_shop_items.
ALTER TABLE public.club_shop_inventory
  ADD COLUMN IF NOT EXISTS stackable_snapshot boolean NOT NULL DEFAULT false;

ALTER TABLE public.club_shop_items
  DROP CONSTRAINT IF EXISTS club_shop_items_per_user_limit_pos;
ALTER TABLE public.club_shop_items
  ADD CONSTRAINT club_shop_items_per_user_limit_pos
  CHECK (per_user_limit IS NULL OR per_user_limit > 0);

ALTER TABLE public.club_shop_items
  DROP CONSTRAINT IF EXISTS club_shop_items_sale_price_valid;
ALTER TABLE public.club_shop_items
  ADD CONSTRAINT club_shop_items_sale_price_valid
  CHECK (sale_price IS NULL OR (sale_price >= 0 AND sale_price <= price));

ALTER TABLE public.club_shop_items
  DROP CONSTRAINT IF EXISTS club_shop_items_window_valid;
ALTER TABLE public.club_shop_items
  ADD CONSTRAINT club_shop_items_window_valid
  CHECK (available_from IS NULL OR available_until IS NULL OR available_until > available_from);

COMMENT ON COLUMN public.club_shop_items.stackable IS
  'Consumables: a player may hold several unredeemed copies. Exempt from uq_shop_inventory_owned_per_item.';
COMMENT ON COLUMN public.club_shop_items.per_user_limit IS
  'Max LIFETIME purchases per member. NULL = unlimited.';
COMMENT ON COLUMN public.club_shop_items.sale_price IS
  'Discounted price actually charged. NULL = charge price.';
COMMENT ON COLUMN public.club_shop_items.sort_order IS
  'Storefront ordering, lower first. Ties fall back to created_at desc.';

-- Consumables stack; permanent unlocks do not.
UPDATE public.club_shop_items
SET stackable = true
WHERE stackable = false
  AND grant_spec->>'type' IN ('time_bank', 'throwable');

UPDATE public.club_shop_inventory inv
SET stackable_snapshot = COALESCE(i.stackable, false)
FROM public.club_shop_items i
WHERE i.id = inv.item_id
  AND inv.stackable_snapshot IS DISTINCT FROM COALESCE(i.stackable, false);

-- Keep the race-proof guarantee for NON-stackable items only.
DROP INDEX IF EXISTS public.uq_shop_inventory_owned_per_item;
CREATE UNIQUE INDEX uq_shop_inventory_owned_per_item
  ON public.club_shop_inventory (user_id, club_id, item_id)
  WHERE status = 'owned' AND stackable_snapshot = false;

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
    SELECT count(*) INTO v_purchased FROM club_shop_purchases
     WHERE club_id = p_club_id AND buyer_id = p_user_id AND item_id = p_item_id;
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
    'stackable', COALESCE(v_item.stackable, false)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_shop_item_availability(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_shop_item_availability(uuid, uuid, uuid) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='club_shop_items' AND column_name='stackable') THEN
    RAISE EXCEPTION 'stackable column missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE tablename='club_shop_inventory'
                   AND indexname='uq_shop_inventory_owned_per_item') THEN
    RAISE EXCEPTION 'ownership uniqueness index missing — the double-buy guard is gone';
  END IF;
  IF has_function_privilege('authenticated',
       'public.fn_shop_item_availability(uuid, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_shop_item_availability must not be executable by authenticated';
  END IF;
END $$;
